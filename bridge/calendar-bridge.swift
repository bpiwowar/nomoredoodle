import Foundation
import EventKit

let bridge_name = "fr.piwowarski.calendar.bridge"
let debug = true

// Log message optionally
func log(_ message: String) {
    // just do nothing
    if !debug { return }

    let logFile = "/tmp/calendar-bridge.log"
    let text = message + "\n"
    if let data = text.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logFile) {
            if let fileHandle = FileHandle(forWritingAtPath: logFile) {
                defer { fileHandle.closeFile() }
                fileHandle.seekToEndOfFile()
                fileHandle.write(data)
            }
        } else {
            FileManager.default.createFile(atPath: logFile, contents: data, attributes: nil)
        }
    }
}

// MARK: - Helpers

let eventStore = EKEventStore()

func requestAccessIfNeeded() {
    let sema = DispatchSemaphore(value: 0)
    eventStore.requestFullAccessToEvents { granted, error in
        if let error = error {
            log("ERROR: EventKit access error: \(error)\n")
        }
        log("DEBUG: access granted = \(granted)\n")
        sema.signal()
    }
    _ = sema.wait(timeout: .now() + 5)
}

func readMessage() -> [String: Any]? {
    var lenBuf = [UInt8](repeating: 0, count: 4)
    guard fread(&lenBuf, 1, 4, stdin) == 4 else { return nil }

    let length = Int(lenBuf[0]) | (Int(lenBuf[1]) << 8) | (Int(lenBuf[2]) << 16) | (Int(lenBuf[3]) << 24)
    guard length > 0 else { return nil }

    var payload = [UInt8](repeating: 0, count: length)
    guard fread(&payload, 1, length, stdin) == length else { return nil }

    if let json = try? JSONSerialization.jsonObject(with: Data(payload), options: []),
       let dict = json as? [String: Any] {
        return dict
    }
    return nil
}

func sendMessage(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
        var lenBuf = [UInt8](repeating: 0, count: 4)
        let length = UInt32(data.count)
        lenBuf[0] = UInt8(length & 0xff)
        lenBuf[1] = UInt8((length >> 8) & 0xff)
        lenBuf[2] = UInt8((length >> 16) & 0xff)
        lenBuf[3] = UInt8((length >> 24) & 0xff)

        fwrite(&lenBuf, 1, 4, stdout)
        fwrite((data as NSData).bytes, 1, data.count, stdout)
        fflush(stdout)
    }
}

// MARK: - Calendar Handling

func listCalendars() -> [String: [[String: String]]] {
    var grouped: [String: [[String: String]]] = [:]
    let calendars = eventStore.calendars(for: .event)

    for cal in calendars {
        let sourceName = cal.source.title
        let entry: [String: String] = [
            "id": cal.calendarIdentifier,
            "title": cal.title,
            "type": cal.type.rawValue.description
        ]
        if grouped[sourceName] == nil { grouped[sourceName] = [] }
        grouped[sourceName]?.append(entry)
    }
    return grouped
}


func getEvents(start: Date, end: Date, calendarIds: [String]) -> [[String: Any]] {
    var eventsArray: [[String: Any]] = []

    // Filter calendars
    let calendars = eventStore.calendars(for: .event)
        .filter { calendarIds.contains($0.calendarIdentifier) }

    // Fetch events in the date range
    let predicate = eventStore.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = eventStore.events(matching: predicate)

    for event in events {
        var ev: [String: Any] = [
            "id": event.eventIdentifier ?? "",
            "title": event.title ?? "",
            "startDate": event.startDate.timeIntervalSince1970,
            "endDate": event.endDate.timeIntervalSince1970,
            "calendarID": event.calendar.calendarIdentifier,
            "calendarTitle": event.calendar.title
        ]
        if let location = event.location { ev["location"] = location }
        if let notes = event.notes { ev["notes"] = notes }
        eventsArray.append(ev)
    }

    return eventsArray
}

// MARK: - Registration
let exePath = URL(fileURLWithPath: CommandLine.arguments[0]).standardized.path

enum Browser {
    case firefox
    case chrome
    case chromium

    var nativeMessagingPath: String {
        let home = NSHomeDirectory()
        switch self {
        case .firefox:
            return "\(home)/Library/Application Support/Mozilla/NativeMessagingHosts"
        case .chrome:
            return "\(home)/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        case .chromium:
            return "\(home)/Library/Application Support/Chromium/NativeMessagingHosts"
        }
    }

    func allowedExtensions(chromeExtensionId: String? = nil) -> [String] {
        switch self {
        case .firefox:
            // Firefox uses just the extension ID
            return ["no-more-doodle@piwowarski.fr"]
        case .chrome, .chromium:
            // Chrome uses chrome-extension://ID/ format
            // This ID is generated from the "key" field in manifest.json
            let id = chromeExtensionId ?? "eodldnljbjjdpncgefjdnanlkkflempf"
            return ["chrome-extension://\(id)/"]
        }
    }
}

func registerNativeHost(for browser: Browser, chromeExtensionId: String? = nil) {
    let allowedList = browser.allowedExtensions(chromeExtensionId: chromeExtensionId)
    let allowedJSON = allowedList.map { "\"\($0)\"" }.joined(separator: ", ")

    // Chrome uses "allowed_origins", Firefox uses "allowed_extensions"
    let allowedKey = (browser == .firefox) ? "allowed_extensions" : "allowed_origins"

    let hostJSON = """
    {
      "name": "\(bridge_name)",
      "description": "Calendar Bridge",
      "path": "\(exePath)",
      "type": "stdio",
      "\(allowedKey)": [\(allowedJSON)]
    }
    """

    let dirPath = browser.nativeMessagingPath
    let hostPath = "\(dirPath)/\(bridge_name).json"

    do {
        // Create directory if it doesn't exist
        try FileManager.default.createDirectory(atPath: dirPath, withIntermediateDirectories: true, attributes: nil)
        try hostJSON.write(toFile: hostPath, atomically: true, encoding: .utf8)
        print("Native host registered for \(browser) at \(hostPath)")
    } catch {
        print("Failed to register native host for \(browser): \(error)")
    }
}

// MARK: - Main

// Helper to get extension ID from arguments
func getChromeExtensionId() -> String? {
    if let index = CommandLine.arguments.firstIndex(of: "--chrome-id"),
       index + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[index + 1]
    }
    return nil
}

let chromeExtId = getChromeExtensionId()

if CommandLine.arguments.contains("--register-firefox") {
    registerNativeHost(for: .firefox)
    exit(0)
}

if CommandLine.arguments.contains("--register-chrome") {
    registerNativeHost(for: .chrome, chromeExtensionId: chromeExtId)
    exit(0)
}

if CommandLine.arguments.contains("--register-chromium") {
    registerNativeHost(for: .chromium, chromeExtensionId: chromeExtId)
    exit(0)
}

if CommandLine.arguments.contains("--register") {
    // Register for all browsers
    registerNativeHost(for: .firefox)
    registerNativeHost(for: .chrome, chromeExtensionId: chromeExtId)
    registerNativeHost(for: .chromium, chromeExtensionId: chromeExtId)
    exit(0)
}

// Regular native messaging mode
log("DEBUG: calendar bridge started\n")
requestAccessIfNeeded()


while true {
    if let message = readMessage() {
        log("DEBUG: received message \(message)\n")

        guard let action = message["action"] as? String else {
            sendMessage(["error": "Missing action field"])
            continue
        }

        switch action {
        case "listCalendars":
            let grouped = listCalendars()
            sendMessage(["calendars": grouped])

        case "getEvents":
			guard let startTS = message["start"] as? TimeInterval else {
				sendMessage(["error": "Missing or invalid 'start'"])
				break
			}

			guard let endTS = message["end"] as? TimeInterval else {
				sendMessage(["error": "Missing or invalid 'end'"])
				break
			}

			guard let calendarIds = message["calendarIds"] as? [String] else {
				sendMessage(["error": "Missing or invalid 'calendarIds'"])
				break
			}

            let events = getEvents(start: Date(timeIntervalSince1970: startTS),
                                end: Date(timeIntervalSince1970: endTS),
                                calendarIds: calendarIds)
            sendMessage(["events": events])

        default:
            sendMessage(["error": "Unknown action \(action)"])
        }

    } else {
        Thread.sleep(forTimeInterval: 0.1)
        log("DEBUG: waiting for message...\n")
    }
}

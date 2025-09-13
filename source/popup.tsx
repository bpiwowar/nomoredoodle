import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCalendars } from "./native-calendar";
import { CalendarEvent } from "./events";

type Calendar = { id: string; title: string };
type CalendarsGrouped = Record<string, Calendar[]>;

// Combine "off" with event statuses
type CalendarStatus = "off" | CalendarEvent["status"];

const STATUSES: CalendarStatus[] = ["off", "if-need-be", "could-be", "no", "yes"];

function nextStatus(status: CalendarStatus): CalendarStatus {
  const idx = STATUSES.indexOf(status);
  return STATUSES[(idx + 1) % STATUSES.length];
}

async function loadStatuses(): Promise<Record<string, CalendarStatus>> {
  const { selectedCalendars = {} } = await chrome.storage.local.get("selectedCalendars");
  return selectedCalendars;
}

async function saveStatuses(statuses: Record<string, CalendarStatus>) {
  await chrome.storage.local.set({ selectedCalendars: statuses });
}

const STATUS_ICONS: Record<CalendarStatus, { icon: string; label: string }> = {
  off: { icon: "⬜", label: "Off" },
  "if-need-be": { icon: "🟦", label: "If need be" },
  "could-be": { icon: "🟩", label: "Could be" },
  no: { icon: "❌", label: "No" },
  yes: { icon: "✅", label: "Yes" },
};

const StatusIcon: React.FC<{ status: CalendarStatus }> = ({ status }) => {
  return <span title={STATUS_ICONS[status].label}>{STATUS_ICONS[status].icon}</span>;
};

function Popup() {
  const [calendars, setCalendars] = useState<CalendarsGrouped>({});
  const [statuses, setStatuses] = useState<Record<string, CalendarStatus>>({});

  useEffect(() => {
    (async () => {
      const cals = await getCalendars();
      setCalendars(cals);
      setStatuses(await loadStatuses());
    })();
  }, []);

  const handleClick = async (id: string) => {
    const newStatus = nextStatus(statuses[id] || "off");
    const newStatuses = { ...statuses, [id]: newStatus };
    setStatuses(newStatuses);
    await saveStatuses(newStatuses);
  };

  return (
    <div className="p-2 text-sm">
      {Object.entries(calendars).map(([provider, cals]) => (
        <div key={provider} className="mb-2">
          <div className="font-bold mb-1">{provider}</div>
          {cals.map((cal) => {
            const status = statuses[cal.id] || "off";
            return (
              <div
                key={cal.id}
                className="flex items-center space-x-2 mb-1 cursor-pointer"
                onClick={() => handleClick(cal.id)}
              >
                <StatusIcon status={status} />{" "}
                <span>{cal.title}</span>
              </div>
            );
          })}
        </div>
      ))}

      <div className="mt-3 pt-2 border-t border-gray-300 text-xs">
        <div className="font-semibold mb-1">Legend</div>
        {STATUSES.map((s) => (
          <div key={s} className="flex items-center space-x-1">
            <StatusIcon status={s} />{" "}
            <span>{STATUS_ICONS[s].label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("calendars")!);
root.render(<Popup />);

// --- The "fill form button"

const fillButton = document.querySelector<HTMLInputElement>('#fill');
if (fillButton) {
	chrome.runtime.sendMessage({type: 'checkSupportedPage'}, resp => {
		console.log('Current page is supported', resp);
		fillButton.disabled = !resp?.supported;
	});

	// Handle click
	fillButton.addEventListener('click', () => {
		chrome.runtime.sendMessage({type: 'fillSlots'});
  });
}
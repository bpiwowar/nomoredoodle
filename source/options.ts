// eslint-disable-next-line import/no-unassigned-import
import 'webext-base-css';
import './options.css';
import optionsStorage from './options-storage.js';

const rangeInputs = [...document.querySelectorAll('input[type="range"][name^="color"]')] as HTMLInputElement[];
const numberInputs = [...document.querySelectorAll('input[type="number"][name^="color"]')] as HTMLInputElement[];
const output = document.querySelector('.color-output') as HTMLElement;

function updateOutputColor() {
	if (output ?.style) {
		output.style.backgroundColor = `rgb(${rangeInputs[0].value}, ${rangeInputs[1].value}, ${rangeInputs[2].value})`;
	}
}

function updateInputField(event: Event) {
	if (event.currentTarget) {
		const target = event.currentTarget as HTMLInputElement;
		numberInputs[rangeInputs.indexOf(target)].value = target.value;
	}
}

for (const input of rangeInputs) {
	input.addEventListener('input', updateOutputColor);
	input.addEventListener('input', updateInputField);
}

async function init() {
	await optionsStorage.syncForm('#options-form');
	updateOutputColor();
}

init();

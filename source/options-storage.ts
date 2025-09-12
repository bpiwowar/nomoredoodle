import OptionsSync from 'webext-options-sync';

export type Options = Record<string, boolean>;

const optionsStorage = new OptionsSync<Options>({
	defaults: {},
	migrations: [
		OptionsSync.migrations.removeUnused,
	],
	logging: true,
});

export default optionsStorage;

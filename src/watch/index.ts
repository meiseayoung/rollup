import { WatchOptions } from 'chokidar';
import { EventEmitter } from 'events';
import path from 'path';
import createFilter from 'rollup-pluginutils/src/createFilter.js';
import rollup, { setWatcher } from '../rollup/index';
import {
	InputOptions,
	OutputChunk,
	OutputOptions,
	RollupBuild,
	RollupCache,
	RollupSingleFileBuild,
	RollupWatchOptions
} from '../rollup/types';
import mergeOptions from '../utils/mergeOptions';
import chokidar from './chokidar';
import { addTask, deleteTask } from './fileWatchers';

const DELAY = 200;

export class Watcher extends EventEmitter {
	private buildTimeout: NodeJS.Timer;
	private running: boolean;
	private rerun: boolean = false;
	private tasks: Task[];
	private succeeded: boolean = false;

	constructor(configs: RollupWatchOptions[] = []) {
		super();
		if (!Array.isArray(configs)) configs = [configs];
		this.tasks = configs.map(config => new Task(this, config));
		this.running = true;
		process.nextTick(() => this.run());
	}

	close() {
		if (this.buildTimeout) clearTimeout(this.buildTimeout);
		this.tasks.forEach(task => {
			task.close();
		});

		this.removeAllListeners();
	}

	invalidate() {
		if (this.running) {
			this.rerun = true;
			return;
		}

		if (this.buildTimeout) clearTimeout(this.buildTimeout);

		this.buildTimeout = setTimeout(() => {
			this.buildTimeout = undefined;
			this.run();
		}, DELAY);
	}

	private run() {
		this.running = true;

		this.emit('event', {
			code: 'START'
		});

		let taskPromise = Promise.resolve();
		for (const task of this.tasks) taskPromise = taskPromise.then(() => task.run());
		return taskPromise
			.then(() => {
				this.succeeded = true;
				this.running = false;

				this.emit('event', {
					code: 'END'
				});
			})
			.catch(error => {
				this.running = false;
				this.emit('event', {
					code: this.succeeded ? 'ERROR' : 'FATAL',
					error
				});
			})
			.then(() => {
				if (this.rerun) {
					this.rerun = false;
					this.invalidate();
				}
			});
	}
}

export class Task {
	private watcher: Watcher;
	private closed: boolean;
	private watched: Set<string>;
	private inputOptions: InputOptions;
	cache: RollupCache;
	watchFiles: string[];
	private chokidarOptions: WatchOptions;
	private chokidarOptionsHash: string;
	private outputFiles: string[];
	private outputs: OutputOptions[];
	private invalidated = true;

	private deprecations: { old: string; new: string }[];

	private filter: (id: string) => boolean;

	constructor(watcher: Watcher, config: RollupWatchOptions) {
		this.cache = null;
		this.watcher = watcher;

		this.closed = false;
		this.watched = new Set();

		const { inputOptions, outputOptions, deprecations } = mergeOptions({
			config
		});
		this.inputOptions = inputOptions;

		this.outputs = outputOptions;
		this.outputFiles = this.outputs.map(output => {
			if (output.file || output.dir) return path.resolve(output.file || output.dir);
		});

		const watchOptions = inputOptions.watch || {};
		if ('useChokidar' in watchOptions) watchOptions.chokidar = watchOptions.useChokidar;
		let chokidarOptions = 'chokidar' in watchOptions ? watchOptions.chokidar : !!chokidar;
		if (chokidarOptions) {
			chokidarOptions = {
				...(chokidarOptions === true ? {} : chokidarOptions),
				ignoreInitial: true
			};
		}

		if (chokidarOptions && !chokidar) {
			throw new Error(
				`watch.chokidar was provided, but chokidar could not be found. Have you installed it?`
			);
		}

		this.chokidarOptions = chokidarOptions;
		this.chokidarOptionsHash = JSON.stringify(chokidarOptions);

		this.filter = createFilter(watchOptions.include, watchOptions.exclude);
		this.deprecations = [...deprecations, ...(watchOptions._deprecations || [])];
	}

	close() {
		this.closed = true;
		this.watched.forEach(id => {
			deleteTask(id, this, this.chokidarOptionsHash);
		});
	}

	invalidate(id: string, isTransformDependency: boolean) {
		this.watcher.emit('change', id);
		this.invalidated = true;
		if (isTransformDependency) {
			this.cache.modules.forEach(module => {
				if (!module.transformDependencies || module.transformDependencies.indexOf(id) === -1)
					return;
				// effective invalidation
				module.originalCode = null;
			});
		}
		this.watcher.invalidate();
	}

	run() {
		if (!this.invalidated) return;
		this.invalidated = false;

		const options = {
			...this.inputOptions,
			cache: this.cache
		};

		const start = Date.now();

		this.watcher.emit('event', {
			code: 'BUNDLE_START',
			input: this.inputOptions.input,
			output: this.outputFiles
		});

		if (this.deprecations.length) {
			this.inputOptions.onwarn({
				code: 'DEPRECATED_OPTIONS',
				deprecations: this.deprecations,
				message: `The following options have been renamed — please update your config: ${this.deprecations
					.map(option => `${option.old} -> ${option.new}`)
					.join(', ')}`
			});
		}

		setWatcher(this.watcher);
		return rollup(options)
			.then(result => {
				if (this.closed) return;

				const watched = (this.watched = new Set());

				this.cache = result.cache;
				this.watchFiles = result.watchFiles;
				this.cache.modules.forEach(module => {
					if (module.transformDependencies) {
						module.transformDependencies.forEach(depId => {
							watched.add(depId);
							this.watchFile(depId, true);
						});
					}
				});
				this.watchFiles.forEach(id => {
					watched.add(id);
					this.watchFile(id);
				});
				this.watched.forEach(id => {
					if (!watched.has(id)) deleteTask(id, this, this.chokidarOptionsHash);
				});

				return Promise.all(
					this.outputs.map(output => {
						return <Promise<OutputChunk | Record<string, OutputChunk>>>result.write(output);
					})
				).then(() => result);
			})
			.then((result: RollupSingleFileBuild | RollupBuild) => {
				this.watcher.emit('event', {
					code: 'BUNDLE_END',
					input: this.inputOptions.input,
					output: this.outputFiles,
					duration: Date.now() - start,
					result
				});
			})
			.catch((error: Error) => {
				if (this.closed) return;

				if (this.cache) {
					// this is necessary to ensure that any 'renamed' files
					// continue to be watched following an error
					if (this.cache.modules) {
						this.cache.modules.forEach(module => {
							if (module.transformDependencies) {
								module.transformDependencies.forEach(depId => {
									this.watchFile(depId, true);
								});
							}
						});
					}
					this.watchFiles.forEach(id => {
						this.watchFile(id);
					});
				}
				throw error;
			});
	}

	watchFile(id: string, isTransformDependency = false) {
		if (!this.filter(id)) return;

		if (this.outputFiles.some(file => file === id)) {
			throw new Error('Cannot import the generated bundle');
		}

		// this is necessary to ensure that any 'renamed' files
		// continue to be watched following an error
		addTask(id, this, this.chokidarOptions, this.chokidarOptionsHash, isTransformDependency);
	}
}

export default function watch(configs: RollupWatchOptions[]) {
	return new Watcher(configs);
}

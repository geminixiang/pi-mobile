const programs = new Map<string, (args: readonly string[]) => object>();
let registered = 0;

export function registerProgram(start: (args: readonly string[]) => object): { program: string; dispose(): void } {
	const program = `pi-mobile-transport-${++registered}`;
	programs.set(program, start);
	return { program, dispose: () => programs.delete(program) };
}

export function spawn(program: string, args: readonly string[]): object {
	const start = programs.get(program);
	if (!start) throw new Error("node:child_process is not available in the app");
	return start(args);
}

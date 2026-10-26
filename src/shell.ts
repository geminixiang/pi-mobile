export function shellQuote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

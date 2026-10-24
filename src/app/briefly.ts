import { useCallback, useEffect, useRef, useState } from "react";

const SHOWN_MS = 2000;

export function useBriefly(): [string | undefined, (text: string) => void] {
	const [text, setText] = useState<string>();
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const show = useCallback((next: string) => {
		clearTimeout(timer.current);
		setText(next);
		timer.current = setTimeout(() => setText(undefined), SHOWN_MS);
	}, []);
	return [text, show];
}

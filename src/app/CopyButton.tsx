import { orLogged } from "../promise.ts";
import { useBriefly } from "./briefly.ts";
import { CheckIcon, CopyIcon } from "./icons.tsx";

export function CopyButton({ text, className = "icon-button small", size = 16 }: { text: string; className?: string; size?: number }) {
	const [copied, showCopied] = useBriefly();
	return (
		<button
			type="button"
			className={className}
			aria-label={copied ?? "複製"}
			onClick={() => void orLogged(navigator.clipboard.writeText(text).then(() => showCopied("已複製")), "clipboard.write_failed", undefined)}
		>
			{copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
		</button>
	);
}

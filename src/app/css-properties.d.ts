import "react";

declare module "react" {
	interface CSSProperties {
		"--fill"?: number;
		"--from"?: number;
		"--to"?: number;
		"--tile"?: string;
		"--share"?: number;
	}
}

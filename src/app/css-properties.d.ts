import "react";

declare module "react" {
	interface CSSProperties {
		"--fill"?: number;
		"--frame-height"?: string;
		"--from"?: number;
		"--to"?: number;
		"--tile"?: string;
		"--share"?: number;
	}
}

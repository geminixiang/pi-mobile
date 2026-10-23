import { defineExtension, section } from "@earendil-works/pi-durable";
import { defineAppTool, text } from "./tools/common.ts";
import { Type } from "typebox";
import spokenReport from "./skills/spoken-report.md?raw";

interface Skill {
	name: string;
	when: string;
	text: string;
}

const SKILLS: readonly Skill[] = [
	{
		name: "spoken-report",
		when: "before writing anything for speak: a headphones briefing, or when the user wants to hear a report",
		text: spokenReport,
	},
];

const readSkill = defineAppTool({
	name: "read_skill",
	description: "Read a skill: instructions for a kind of task, listed in the system prompt. Read it before doing that task.",
	parameters: Type.Object({ name: Type.Union(SKILLS.map((skill) => Type.Literal(skill.name)), { description: "A skill listed in the system prompt" }) }),
	execute: async (args) => {
		const skill = SKILLS.find((candidate) => candidate.name === args.name);
		if (!skill) throw new Error(`no skill ${args.name}`);
		return text(skill.text);
	},
});

export const SkillsExtension = defineExtension({
	name: "skills",
	tools: [readSkill],
	sections: [
		section("skills", () =>
			[
				"Skills: read one with read_skill before the task it is for, once per conversation unless it left your context.",
				...SKILLS.map((skill) => `- ${skill.name}: ${skill.when}`),
			].join("\n"),
		),
	],
});

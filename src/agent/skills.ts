// Skills: instructions for one kind of task, loaded when the task comes up rather than sent with every request. The
// system prompt lists each skill's name and when to use it; read_skill returns the full text. Same idea as pi's
// skills. Built in for now; a bot's own skills can join the list later.
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import spokenReport from "./skills/spoken-report.md?raw";

interface Skill {
	name: string;
	/** When to read it, for the list in the system prompt. */
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

const readSkill = defineTool({
	name: "read_skill",
	description: "Read a skill: instructions for a kind of task, listed in the system prompt. Read it before doing that task.",
	parameters: Type.Object({ name: Type.Union(SKILLS.map((skill) => Type.Literal(skill.name))) }),
	execute: async (args) => {
		const skill = SKILLS.find((candidate) => candidate.name === args.name);
		if (!skill) throw new Error(`no skill ${args.name}`);
		return { output: [{ type: "text", text: skill.text }] };
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

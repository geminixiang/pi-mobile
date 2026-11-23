import { useState } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import { RowList } from "pi-mobile-ui/elements";
import { Sheet } from "pi-mobile-ui/shell";
import { useSubscribed } from "pi-mobile-ui/store";
import { messageOf } from "pi-mobile-base/promise";
import type { Skill, Skills } from "./skills.ts";

const NO_SKILLS: readonly Skill[] = [];

export function SkillsSheet({ skills, bot, open, onClose }: { skills: Skills; bot: ConversationId; open: boolean; onClose: () => void }) {
	const list = useSubscribed<readonly Skill[]>(NO_SKILLS, (listener) => skills.subscribe(bot, listener), [skills, bot]);
	const [shown, setShown] = useState<string>();
	const [problem, setProblem] = useState<string>();
	const skill = list.find((candidate) => candidate.name === shown);
	const close = () => {
		setShown(undefined);
		setProblem(undefined);
		onClose();
	};
	return (
		<Sheet open={open} title={skill ? skill.name : "技能"} onClose={close}>
			{skill ? (
				<div className="skill-detail">
					<p className="list-sub">{skill.description}</p>
					<p className="skill-text">{skill.text}</p>
					<div className="item-actions">
						<button type="button" className="btn" onClick={() => setShown(undefined)}>
							返回
						</button>
						<button
							type="button"
							className="btn danger"
							onClick={() => void skills.remove(bot, skill.name).then(() => setShown(undefined), (error: unknown) => setProblem(messageOf(error)))}
						>
							刪除
						</button>
					</div>
				</div>
			) : (
				<RowList>
					{list.length === 0 ? <p className="row-empty">還沒有。跟 Bot 說「以後都這樣做」，它會存成技能。</p> : null}
					{list.map((candidate) => (
						<button key={candidate.name} type="button" onClick={() => setShown(candidate.name)}>
							<span className="list-text">
								<span className="list-name">{candidate.name}</span>
								<span className="list-sub">{candidate.description}</span>
							</span>
						</button>
					))}
				</RowList>
			)}
			{problem ? <p className="item-problem">{problem}</p> : null}
		</Sheet>
	);
}

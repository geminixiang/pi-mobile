import { type Bot, avatarOf } from "../agent/bots.ts";

export function BotAvatar({ bot, size = 30 }: { bot: Pick<Bot, "avatar">; size?: number }) {
	return <img className="bot-avatar" src={`/avatars/${avatarOf(bot)}.webp`} width={size} height={size} alt="" draggable={false} />;
}

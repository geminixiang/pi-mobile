import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, type LucideIcon, Sun } from "lucide-react";
import { useContext } from "react";
import { FileIcon } from "../app/icons.tsx";
import { OpenFileContext } from "../app/openFile.ts";
import { PageFrame, usePageHtml } from "./PageFrame.tsx";
import type { Page } from "./pages.ts";
import type { AlertResult, WeatherResult } from "./results.ts";

const ICONS: readonly (readonly [string, LucideIcon])[] = [
	["雷", CloudLightning],
	["雪", CloudSnow],
	["冰", CloudSnow],
	["毛毛雨", CloudDrizzle],
	["雨", CloudRain],
	["霧", CloudFog],
	["大致晴朗", CloudSun],
	["晴", Sun],
	["多雲", CloudSun],
];

function Condition({ text, size }: { text: string; size: number }) {
	const Icon = ICONS.find(([word]) => text.includes(word))?.[1] ?? Cloud;
	return <Icon size={size} strokeWidth={1.6} aria-label={text} />;
}

const degrees = (value: number) => `${Math.round(value)}°`;

const WEEKDAYS = "日一二三四五六";

function dayName(date: string, at: number): string {
	const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
	const local = new Date(year, month - 1, day);
	return local.toDateString() === new Date(at).toDateString() ? "今天" : `週${WEEKDAYS[local.getDay()]}`;
}

export function AlertCard({ card }: { card: AlertResult }) {
	return (
		<section className="note error alert-card">
			<p>電腦上的 agent 回報裡有想指揮 Bot 的文字。這不是你說的，已提醒 Bot 不要照做。</p>
			<blockquote>{card.quote}</blockquote>
		</section>
	);
}

export function WeatherCard({ card }: { card: WeatherResult }) {
	const low = Math.min(...card.days.map((day) => day.low_c));
	const span = Math.max(...card.days.map((day) => day.high_c)) - low || 1;
	return (
		<section className="question-card weather">
			<p className="weather-place">{card.place}</p>
			<div className="weather-now">
				<Condition text={card.now.condition} size={40} />
				<span className="weather-temperature">{degrees(card.now.temperature_c)}</span>
				<span className="weather-condition">
					{card.now.condition}
					<small>體感 {degrees(card.now.feels_c)}</small>
				</span>
			</div>
			<ol className="weather-hours">
				{card.hours.map((hour) => (
					<li key={hour.time}>
						<span>{hour.time.slice(11, 16)}</span>
						<Condition text={hour.condition} size={20} />
						<strong>{degrees(hour.temperature_c)}</strong>
					</li>
				))}
			</ol>
			<ol className="weather-days">
				{card.days.map((day) => (
					<li key={day.date}>
						<span className="weather-day">{dayName(day.date, card.at)}</span>
						<Condition text={day.condition} size={18} />
						<span className="weather-rain">{day.rain_chance >= 20 ? `${day.rain_chance}%` : ""}</span>
						<span className="weather-low">{degrees(day.low_c)}</span>
						<span className="weather-range">
							<i style={{ "--from": (day.low_c - low) / span, "--to": (day.high_c - low) / span }} />
						</span>
						<span>{degrees(day.high_c)}</span>
					</li>
				))}
			</ol>
		</section>
	);
}

export function PageCard({ page }: { page: Page }) {
	const openFile = useContext(OpenFileContext);
	const html = usePageHtml(page);
	if (html) return <PageFrame page={page} html={html} />;
	return (
		<button type="button" className="question-card page-card" disabled={!openFile} onClick={() => openFile?.(page.path)}>
			<span className="page-title">{page.title}</span>
			{page.summary ? <span className="page-summary">{page.summary}</span> : null}
			<span className="page-file">
				<FileIcon size={18} />
				<span>頁面</span>
			</span>
		</button>
	);
}

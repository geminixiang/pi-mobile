import { useState } from "react";
import { type CalendarAccess, canWrite, groupByAccount } from "../agent/calendar-access.ts";
import { phonePermissions } from "../interaction/phone-permissions.ts";
import { native } from "../native.ts";
import { messageOf } from "pi-mobile-base/promise";
import { ChoiceRow } from "../ui/ChoiceRow.tsx";
import { RowList } from "../ui/RowList.tsx";
import { promised, useStore } from "../ui/subscribed.ts";
import { Calendar, type PhoneCalendar } from "./plugin.ts";

export function CalendarGroup({ access, onChange }: { access: CalendarAccess; onChange: (access: CalendarAccess) => void }) {
	const [error, setError] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const fail = (failure: unknown) => {
		setError(messageOf(failure));
		return undefined;
	};
	const list = () => Calendar.listAccounts().then((accounts) => accounts.calendars);
	const listIfAllowed = async () => (native.has("Calendar") && (await Calendar.checkPermissions()).calendar === "granted" ? list() : undefined);
	const [calendars, setCalendars] = useStore<PhoneCalendar[] | undefined>(undefined, promised(() => listIfAllowed().catch(fail)), []);
	const askThenLoad = () =>
		phonePermissions.request("calendar").then((allowed) => (allowed ? list().then(setCalendars, fail) : fail(new Error("沒有行事曆權限，到手機設定開啟"))), fail);
	if (!native.has("Calendar")) return null;

	const toggle = (list: string[], key: string, on: boolean) => (on ? [...new Set([...list, key])] : list.filter((item) => item !== key));
	const groups = calendars ? groupByAccount(calendars) : [];
	const hiddenGroups = groups.filter((group) => access.hidden.includes(group.key));
	const sharedCount = calendars?.filter((calendar) => !calendar.own).length ?? 0;
	const writableTargets = (calendars ?? []).filter((calendar) => calendar.writable && canWrite(access, calendar));

	type Use = "off" | "read" | "write";
	const choose = (group: { key: string; calendars: PhoneCalendar[] }, use: Use) => {
		const ids = new Set(group.calendars.map((calendar) => calendar.id));
		const holdsDefault = access.defaultCalendar !== undefined && ids.has(access.defaultCalendar);
		const writeTarget = group.calendars.find((calendar) => calendar.writable && calendar.primary) ?? group.calendars.find((calendar) => calendar.writable);
		onChange({
			...access,
			hidden: toggle(access.hidden, group.key, use === "off"),
			writable: toggle(access.writable, group.key, use === "write"),
			defaultCalendar:
				use === "write" ? (access.defaultCalendar ?? writeTarget?.id) : holdsDefault ? undefined : access.defaultCalendar,
		});
	};

	const accountRow = (group: { key: string; label: string; calendars: PhoneCalendar[] }) => {
		const readable = !access.hidden.includes(group.key);
		return (
			<ChoiceRow<Use>
				key={group.key}
				label={group.label}
				hint={group.calendars.some((calendar) => !group.label.startsWith(calendar.name)) ? group.calendars.map((calendar) => calendar.name).join("、") : undefined}
				value={!readable ? "off" : access.writable.includes(group.key) ? "write" : "read"}
				choices={[
					{ value: "off", label: "不用" },
					{ value: "read", label: "只讀" },
					{ value: "write", label: "讀寫", disabled: !group.calendars.some((calendar) => calendar.writable) },
				]}
				onChoose={(use) => choose(group, use)}
			/>
		);
	};

	return (
		<RowList title="行事曆">
			{calendars === undefined ? (
				<button type="button" onClick={() => void askThenLoad()}>
					<span className="menu-text">
						讀取帳號清單
						{error ? <span className="index-status error">{error}</span> : null}
					</span>
				</button>
			) : (
				<>
					{groups.filter((group) => !access.hidden.includes(group.key)).map(accountRow)}
					{hiddenGroups.length > 0 && !showHidden ? (
						<button type="button" onClick={() => setShowHidden(true)}>
							<span className="menu-text">其他 {hiddenGroups.length} 個帳號</span>
							<span className="row-value">不用</span>
						</button>
					) : null}
					{showHidden ? hiddenGroups.map(accountRow) : null}
					{sharedCount > 0 ? (
						<ChoiceRow
							label={`${sharedCount} 個分享的行事曆`}
							value={access.shared ? "read" : "off"}
							choices={[
								{ value: "off", label: "不用" },
								{ value: "read", label: "只讀" },
							]}
							onChoose={(use) => onChange({ ...access, shared: use === "read" })}
						/>
					) : null}
					{writableTargets.length > 0 ? (
						<ChoiceRow
							label="新行程寫到"
							value={String(access.defaultCalendar ?? "")}
							shown={writableTargets.find((calendar) => calendar.id === access.defaultCalendar)?.name}
							choices={[
								{ value: "", label: "每次問我" },
								...writableTargets.map((calendar) => ({
									value: String(calendar.id),
									label: calendar.name === calendar.account ? calendar.account : `${calendar.name} · ${calendar.account}`,
								})),
							]}
							onChoose={(id) => onChange({ ...access, defaultCalendar: id ? Number(id) : undefined })}
						/>
					) : null}
				</>
			)}
		</RowList>
	);
}

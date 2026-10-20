/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Format assertions, only used when a schema is compiled with `assertFormats`.
 * Unknown formats always pass. Formats only apply to strings.
 */
export function checkFormat(format: string, value: string): boolean {
	const checker = FORMATS.get(format);
	return checker ? checker(value) : true;
}

const FORMATS = new Map<string, (value: string) => boolean>([
	['date', isDate],
	['time', isTime],
	['date-time', isDateTime],
	['email', isEmail],
	['uri', isUri],
	['uri-reference', isUriReference],
	['uuid', isUuid],
	['ipv4', isIpv4],
	['ipv6', isIpv6],
	['regex', isRegex],
	['json-pointer', isJsonPointer],
]);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(z|[+-]\d{2}:\d{2})$/i;
const DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[t ](.+)$/i;

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** RFC 3339 full-date. */
function isDate(value: string): boolean {
	const match = DATE_PATTERN.exec(value);
	if (!match) {
		return false;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) {
		return false;
	}
	const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	return day <= daysInMonth;
}

/** RFC 3339 full-time, including the leap second rule. */
function isTime(value: string): boolean {
	const match = TIME_PATTERN.exec(value);
	if (!match) {
		return false;
	}
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = Number(match[3]);
	if (hour > 23 || minute > 59 || second > 60) {
		return false;
	}
	let offsetMinutes = 0;
	if (match[4].toLowerCase() !== 'z') {
		const offsetHour = Number(match[4].slice(1, 3));
		const offsetMinute = Number(match[4].slice(4, 6));
		if (offsetHour > 23 || offsetMinute > 59) {
			return false;
		}
		offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[4][0] === '-' ? -1 : 1);
	}
	if (second === 60) {
		// Leap seconds only occur at 23:59:60 UTC.
		const utcMinutes = (((hour * 60 + minute - offsetMinutes) % 1440) + 1440) % 1440;
		return utcMinutes === 23 * 60 + 59;
	}
	return true;
}

/** RFC 3339 date-time. */
function isDateTime(value: string): boolean {
	const match = DATE_TIME_PATTERN.exec(value);
	return !!match && isDate(match[1]) && isTime(match[2]);
}

function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+$/.test(value);
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isUri(value: string): boolean {
	return SCHEME_PATTERN.test(value) && !/[\s\\]/.test(value) && URL.canParse(value);
}

function isUriReference(value: string): boolean {
	if (/[\s\\]/.test(value)) {
		return false;
	}
	return SCHEME_PATTERN.test(value) ? URL.canParse(value) : URL.canParse(value, 'http://placeholder.invalid/');
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isIpv4(value: string): boolean {
	const parts = value.split('.');
	return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
	if (!/^[0-9A-Fa-f:.]+$/.test(value)) {
		return false;
	}
	const halves = value.split('::');
	if (halves.length > 2) {
		return false;
	}
	const head = halves[0] === '' ? [] : halves[0].split(':');
	const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
	const groups = [...head, ...tail];
	let count = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		if (i === groups.length - 1 && group.includes('.')) {
			if (!isIpv4(group)) {
				return false;
			}
			count += 2;
		} else if (/^[0-9A-Fa-f]{1,4}$/.test(group)) {
			count++;
		} else {
			return false;
		}
	}
	return halves.length === 2 ? count < 8 : count === 8;
}

function isRegex(value: string): boolean {
	try {
		new RegExp(value, 'u');
		return true;
	} catch {
		return false;
	}
}

function isJsonPointer(value: string): boolean {
	return /^(?:\/(?:[^~/]|~[01])*)*$/.test(value);
}

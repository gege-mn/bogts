import { describe, expect, it } from 'vitest';
import { CHANNEL_KINDS, NOTIFICATION_TYPE_OPTIONS } from './notify';
import { NOTIFICATION_TYPES, NOTIFY_CHANNEL_KINDS } from './server/schema';

describe('the dashboard’s channel wording', () => {
	it('covers every channel kind and notification type the schema has', () => {
		expect(CHANNEL_KINDS.map((k) => k.kind)).toEqual([...NOTIFY_CHANNEL_KINDS]);
		expect(NOTIFICATION_TYPE_OPTIONS.map((t) => t.type)).toEqual([...NOTIFICATION_TYPES]);
	});
});

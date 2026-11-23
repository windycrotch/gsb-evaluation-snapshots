/** Types for relay.mjs and ws.mjs, which are plain JavaScript so they can be run with nothing but node. */
import type { Server } from 'node:http';

export const ALPHABET: string;
export const CODE_LENGTH: number;
export const MAX_PLAYERS: number;
export const IDLE_MS: number;
export const REJOIN_MS: number;
export const KEY_LENGTH: number;
export const KEEPALIVE_MS: number;

export function makeCode(rand?: (n: number) => number): string;
export function makeKey(rand?: (n: number) => number): string;
export function normaliseCode(input: unknown): string | undefined;
/** The same discriminated shape the poll uses, so a caller can read `.error` without narrowing first. */
export type Join =
  | { create: true; code?: undefined; key?: undefined; error?: undefined }
  | { create?: undefined; code: string; key?: string; error?: undefined }
  | { create?: undefined; code?: undefined; key?: undefined; error: string };
export function parseJoin(text: string): Join;
export function tag(slot: number, payload: Uint8Array): Buffer;

/** A seat in a room: the connection, the key that may come back for it, whether it is currently sat in,
 *  and the newest race generation its packets have belonged to. */
export interface Member<T = unknown> { key?: string; conn: T | undefined; gone: boolean; goneAt?: number; gen: number }
export interface Room<T = unknown> { members: Map<number, Member<T>>; at: number }

export interface Joined { slot: number; peers: number[] }
export interface Rejoined extends Joined { back: true; replaced?: unknown }
export class Rooms {
  constructor(max?: number, now?: () => number);
  readonly rooms: Map<string, Room>;
  create(rand?: (n: number) => number): string | undefined;
  join<T>(code: string, member: T, key?: string):
    | (Joined & { back?: undefined; replaced?: undefined; error?: undefined })
    | (Rejoined & { error?: undefined })
    | { slot?: undefined; peers?: undefined; back?: undefined; replaced?: undefined; error: string };
  leave(code: string, slot: number): void;
  others<T>(code: string, slot: number, gen?: number): T[];
  size(code: string): number;
  sweep(): void;
}

export function start(port?: number): Server;

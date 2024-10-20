import { BaseEncodingOptions as Alias1, BigIntOptions as Alias2 } from 'node:fs';

interface Promise$3 {
}
interface Date$2 {
}
export interface Int {
	localD: Date$2;
	globalD: Date;
	localP: Promise$3;
	globalP: Promise<number>;
}
export interface Interface1 extends Alias1 {
}
export interface Interface2 extends Alias2 {
}
declare module "node:fs" {
	interface BaseEncodingOptions {
		newField: string;
	}
	class BigIntOptions {
		newField: string;
	}
}

export {};

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IJsonSchemaValidationError, IJsonSchemaValidationResult } from './index.js';
import { Annotations, evaluateKeywords, IEvalContext, ISchemaResource, SchemaNode } from './keywords.js';

/** Thrown when validating an instance exceeds the evaluation, time or reference-hop budget. */
export class JsonSchemaBudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'JsonSchemaBudgetExceededError';
	}
}

export interface IValidateInstanceOptions {
	readonly evalBudget: number;
	readonly timeBudgetMs: number | undefined;
	readonly maxRefHops: number;
	readonly assertFormats: boolean;
}

export function validateInstance(root: SchemaNode, instance: unknown, options: IValidateInstanceOptions): IJsonSchemaValidationResult {
	const ctx = new EvalContext(options);
	const valid = ctx.evaluate(root, instance, '', undefined);
	return { valid, errors: ctx.errors };
}

class EvalContext implements IEvalContext {
	public readonly errors: IJsonSchemaValidationError[] = [];
	public readonly assertFormats: boolean;

	private readonly evalBudget: number;
	private readonly maxRefHops: number;
	private readonly deadline: number | undefined;
	private remainingBudget: number;
	private ticks = 0;
	/** Consecutive reference hops at the current instance location. */
	private refHops = 0;
	/** The dynamic scope: schema resources entered on the way to the current schema, outermost first. */
	private readonly scope: ISchemaResource[] = [];

	constructor(options: IValidateInstanceOptions) {
		this.evalBudget = options.evalBudget;
		this.remainingBudget = options.evalBudget;
		this.maxRefHops = options.maxRefHops;
		this.assertFormats = options.assertFormats;
		this.deadline = options.timeBudgetMs === undefined ? undefined : Date.now() + options.timeBudgetMs;
	}

	tick(): void {
		if (--this.remainingBudget < 0) {
			throw new JsonSchemaBudgetExceededError(`JSON Schema validation exceeded the budget of ${this.evalBudget} keyword evaluations`);
		}
		if (this.deadline !== undefined && (++this.ticks & 0xff) === 0 && Date.now() >= this.deadline) {
			throw new JsonSchemaBudgetExceededError('JSON Schema validation exceeded its time budget');
		}
	}

	evaluate(node: SchemaNode, instance: unknown, instancePath: string, out: Annotations | undefined): boolean {
		const entering = this.scope[this.scope.length - 1] !== node.resource;
		if (entering) {
			this.scope.push(node.resource);
		}
		const valid = evaluateKeywords(node, instance, instancePath, this, out);
		if (entering) {
			this.scope.pop();
		}
		return valid;
	}

	evaluateChild(node: SchemaNode, instance: unknown, instancePath: string): boolean {
		const savedHops = this.refHops;
		this.refHops = 0;
		const valid = this.evaluate(node, instance, instancePath, undefined);
		this.refHops = savedHops;
		return valid;
	}

	followRef(target: SchemaNode, instance: unknown, instancePath: string, out: Annotations | undefined): boolean {
		if (++this.refHops > this.maxRefHops) {
			throw new JsonSchemaBudgetExceededError(`JSON Schema validation followed more than ${this.maxRefHops} consecutive references (possible reference cycle)`);
		}
		const valid = this.evaluate(target, instance, instancePath, out);
		this.refHops--;
		return valid;
	}

	resolveDynamicRef(initial: SchemaNode, anchor: string | undefined): SchemaNode {
		if (anchor === undefined) {
			return initial;
		}
		for (const resource of this.scope) {
			const candidate = resource.dynamicAnchors.get(anchor);
			if (candidate) {
				return candidate;
			}
		}
		return initial;
	}

	error(node: SchemaNode, keyword: string, instancePath: string, message: string): void {
		const document = node.resource.document;
		const schemaPath = (document.isRoot ? '' : document.uri) + '#' + node.pointer + (keyword === 'false' ? '' : '/' + keyword);
		this.errors.push({ instancePath, schemaPath, keyword, message });
	}

	beginTrial(): number {
		return this.errors.length;
	}

	endTrial(mark: number, keepErrors: boolean): void {
		if (!keepErrors) {
			this.errors.length = mark;
		}
	}
}

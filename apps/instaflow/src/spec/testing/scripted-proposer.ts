/**
 * Test-only: a `SpecProposer` that plays a fixed script of turns (the M2 agent's stand-in). A turn is
 * a spec (any value: the proposals service parses it as untrusted input), an error, or `undefined`
 * ("nothing to propose"). It records the context it was asked with.
 */
import { err, ok, type SfError } from '@staticflux/core';
import type { ProposalSource, ProposerContext, ProposerTurn, SpecProposer } from '../proposals.js';

export type ScriptedTurn = ProposerTurn | SfError | undefined;

export interface ScriptedProposer extends SpecProposer {
  readonly asked: readonly ProposerContext[];
  readonly remaining: number;
}

const isError = (turn: ScriptedTurn): turn is SfError => turn instanceof Error;

export function scriptedProposer(turns: readonly ScriptedTurn[], source: ProposalSource = { kind: 'agent', id: 'scripted', displayName: 'Scripted agent' }): ScriptedProposer {
  const queue = [...turns];
  const asked: ProposerContext[] = [];
  return {
    source,
    asked,
    get remaining() {
      return queue.length;
    },
    async next(context, signal) {
      asked.push(context);
      if (signal.aborted) return ok(undefined);
      const turn = queue.shift();
      return isError(turn) ? err(turn) : ok(turn);
    },
  };
}

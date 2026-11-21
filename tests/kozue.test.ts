import { describe, expect, it } from 'vitest';
import { buildUml, kindLabel } from '../src/tools/kozue/adapter';
import { GO_SAMPLE, TS_SAMPLE } from '../src/tools/samples';

const STATE_SAMPLE = `export type OrderStatus = 'draft' | 'pending' | 'paid' | 'shipped' | 'cancelled';

export function advance(order: { status: OrderStatus }, next: OrderStatus): OrderStatus {
  if (order.status === 'cancelled') {
    throw new Error('cancelled orders cannot move');
  }
  if (order.status === 'draft') {
    return 'pending';
  }
  if (order.status === 'pending') {
    return next === 'paid' ? 'paid' : 'pending';
  }
  if (order.status === 'paid') {
    return next === 'shipped' ? 'shipped' : 'paid';
  }
  return order.status;
}
`;

const LOOP_SAMPLE = `export function sumEven(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value < 0) {
      continue;
    }
    if (value % 2 !== 0) {
      continue;
    }
    total += value;
  }
  while (total > 1000) {
    total = Math.floor(total / 2);
  }
  return total;
}
`;

const COMPONENT_SAMPLE = `import express from 'express';
import axios from 'axios';
import pino from 'pino';
import { z } from 'zod';
import { makeRouter } from './router';
import { loadConfig } from './config';

export function bootstrap(): void {
  const app = express();
  const log = pino();
  const schema = z.object({ id: z.string() });
  log.info(schema.parse({ id: 'x' }));
  void axios.get('/health');
  makeRouter(app, loadConfig());
}
`;

describe('Kozue UML auto-architect', () => {
  it('picks a class diagram for a type-rich service', () => {
    const output = buildUml('payment-service.ts', TS_SAMPLE, { kind: 'auto', direction: 'TD' });
    expect(output.detection.selected).toBe('class');
    expect(output.detection.confidence).toBeGreaterThan(0.5);
    expect(output.detection.candidates).toHaveLength(5);
    expect(output.detection.candidates[0].reasons.length).toBeGreaterThan(0);
    expect(output.mermaid.class).toContain('classDiagram');
    expect(output.mermaid.class).toContain('PaymentService');
  });

  it('detects a state diagram from status literals', () => {
    const output = buildUml('order.ts', STATE_SAMPLE, { kind: 'auto', direction: 'TD' });
    expect(output.detection.selected).toBe('state');
    expect(output.mermaid.state).toContain('stateDiagram-v2');
    expect(output.mermaid.state).toContain('draft');
  });

  it('detects an activity diagram for a single procedural function', () => {
    const output = buildUml('sum.ts', LOOP_SAMPLE, { kind: 'auto', direction: 'TD' });
    expect(output.detection.selected).toBe('activity');
    expect(output.mermaid.activity).toContain('flowchart TD');
    expect(output.mermaid.activity).toContain('Start');
  });

  it('detects a component diagram when many external modules are imported', () => {
    const output = buildUml('bootstrap.ts', COMPONENT_SAMPLE, { kind: 'auto', direction: 'LR' });
    expect(output.detection.selected).toBe('component');
    expect(output.mermaid.component).toContain('flowchart LR');
    expect(output.mermaid.component).toContain('express');
  });

  it('renders all five Mermaid kinds and respects the direction', () => {
    const output = buildUml('billing_service.go', GO_SAMPLE, { kind: 'auto', direction: 'LR' });
    expect(Object.keys(output.mermaid)).toEqual(['sequence', 'class', 'state', 'activity', 'component']);
    expect(output.mermaid.sequence.startsWith('sequenceDiagram')).toBe(true);
    expect(output.mermaid.class.startsWith('classDiagram')).toBe(true);
    expect(output.mermaid.state.startsWith('stateDiagram-v2')).toBe(true);
    expect(output.mermaid.activity).toContain('flowchart');
    expect(output.mermaid.component).toContain('flowchart');
  });

  it('allows a manual kind override', () => {
    const output = buildUml('payment-service.ts', TS_SAMPLE, { kind: 'sequence', direction: 'TD' });
    expect(output.activeKind).toBe('sequence');
    expect(output.autoSelection).not.toBe('sequence');
  });

  it('labels every kind', () => {
    expect(kindLabel('sequence')).toBe('Sequence Diagram');
    expect(kindLabel('class')).toBe('Class Diagram');
    expect(kindLabel('state')).toBe('State Diagram');
    expect(kindLabel('activity')).toBe('Activity Diagram');
    expect(kindLabel('component')).toBe('Component Diagram');
  });

  it('never emits empty Mermaid bodies', () => {
    const output = buildUml('empty.ts', '// nothing here\n', { kind: 'auto', direction: 'TD' });
    for (const code of Object.values(output.mermaid)) {
      expect(code.split('\n').length).toBeGreaterThan(1);
    }
  });
});

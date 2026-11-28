import type { Lang } from '../parser/types';

/**
 * WO-F01 — independent ground truth corpus.
 *
 * Every case is written by hand from the language's documented syntax and does
 * not import parser helpers. The inputs use only constructs the heuristic
 * parsers claim to support; anything else is out of scope for the score and is
 * listed in the limitations instead of being counted as a success.
 */

export interface GroundTruthExpectation {
  functions: string[];
  types: { name: string; kind: string }[];
  imports: { module: string; external: boolean }[];
}

export interface GroundTruthCase {
  id: string;
  language: Lang;
  fileName: string;
  source: string;
  expected: GroundTruthExpectation;
}

export const GROUND_TRUTH: readonly GroundTruthCase[] = [
  {
    id: 'typescript-basic',
    language: 'typescript',
    fileName: 'point.ts',
    source: `import { helper } from './helper';
export interface Point {
  x: number;
  y: number;
}
export function add(a: number, b: number): number {
  return a + b;
}
`,
    expected: {
      functions: ['add'],
      types: [{ name: 'Point', kind: 'interface' }],
      imports: [{ module: './helper', external: false }],
    },
  },
  {
    id: 'javascript-basic',
    language: 'javascript',
    fileName: 'run.js',
    source: `const path = require('path');
function run(x) {
  return x;
}
module.exports = { run };
`,
    expected: {
      functions: ['run'],
      types: [],
      imports: [{ module: 'path', external: true }],
    },
  },
  {
    id: 'python-basic',
    language: 'python',
    fileName: 'store.py',
    source: `import os
from utils import parse

class Store:
    def get(self, key):
        return key

def build(path):
    return parse(path)
`,
    expected: {
      functions: ['get', 'build'],
      types: [{ name: 'Store', kind: 'class' }],
      imports: [
        { module: 'os', external: true },
        { module: 'utils', external: true },
      ],
    },
  },
  {
    id: 'java-basic',
    language: 'java',
    fileName: 'Cart.java',
    source: `import java.util.List;

public class Cart {
  public int total(List<Integer> items) {
    return items.size();
  }
}
`,
    expected: {
      functions: ['total'],
      types: [{ name: 'Cart', kind: 'class' }],
      imports: [{ module: 'java.util.List', external: false }],
    },
  },
  {
    id: 'go-basic',
    language: 'go',
    fileName: 'main.go',
    source: `package main

import "fmt"

type Item struct {
  Name string
}

func add(a int, b int) int {
  return a + b
}
`,
    expected: {
      functions: ['add'],
      types: [{ name: 'Item', kind: 'struct' }],
      imports: [{ module: 'fmt', external: true }],
    },
  },
  {
    id: 'c-basic',
    language: 'c',
    fileName: 'main.c',
    source: `#include <stdio.h>
#include "util.h"

int add(int a, int b) {
  return a + b;
}
`,
    expected: {
      functions: ['add'],
      types: [],
      imports: [
        { module: 'stdio.h', external: true },
        { module: 'util.h', external: false },
      ],
    },
  },
  {
    id: 'cpp-basic',
    language: 'cpp',
    fileName: 'engine.cpp',
    source: `#include <vector>
#include "engine.h"

class Engine {
 public:
  int run(int input);
 private:
  int size_;
};

int Engine::run(int input) {
  return input;
}
`,
    expected: {
      functions: ['run'],
      types: [{ name: 'Engine', kind: 'class' }],
      imports: [
        { module: 'vector', external: true },
        { module: 'engine.h', external: false },
      ],
    },
  },
  {
    id: 'csharp-basic',
    language: 'csharp',
    fileName: 'Order.cs',
    source: `using System;

public class Order {
  public int AddItem(int price) {
    return price;
  }
}
`,
    expected: {
      functions: ['AddItem'],
      types: [{ name: 'Order', kind: 'class' }],
      imports: [{ module: 'System', external: true }],
    },
  },
];

export const GROUND_TRUTH_LIMITATIONS = [
  'C/C++ multi-line declarations, templates and macros are out of scope.',
  'C# expression-bodied members and records are out of scope.',
  'Imports are compared by module string and external flag; alias expansion is out of scope.',
  'Type kinds are compared where the parser claims the construct (class/struct/interface/enum).',
] as const;

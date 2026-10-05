// Tiny dependency-free test runner for plain gjs: `gjs -m tests/run.js`.
// Test files use the globals describe/it/equal/throws defined here.
//
// READING GUIDE (for developers new to GNOME extensions or JavaScript)
//
// Why this exists: the pure modules (keys.js, layout.js, layouts/us.js) have no
// GNOME dependencies, so they can be tested by running them with `gjs`, GNOME's
// JavaScript interpreter (like Node.js, but with GNOME libraries). To keep the
// project dependency-free there is no Jest/Mocha; this ~50 line file provides
// just enough of one. `make test` runs it. It prints one FAIL block per failing
// test and a final "N passed, M failed" line, and exits non-zero on failure.
//
// The `-m` flag in `gjs -m` means "treat the file as an ES module", which is
// what allows `import` and top-level `await` below.
import System from 'system';  // gjs built-in module; only used for System.exit

// Running totals, and the stack of enclosing describe() names so a failure can
// be reported as "group > subgroup > test name".
let failures = 0;
let passed = 0;
let prefix = [];

// describe(name, fn): group tests. Runs fn immediately; any it() inside is
// labelled with this name. Groups may be nested.
globalThis.describe = (name, fn) => {
    prefix.push(name);
    fn();
    prefix.pop();
};

// it(name, fn): one test. It passes if fn returns without throwing. A thrown
// error is caught, counted and printed so the remaining tests still run.
// `prefix.concat(name)` builds the full path without modifying `prefix`.
globalThis.it = (name, fn) => {
    const full = prefix.concat(name).join(' > ');
    try {
        fn();
        passed++;
    } catch (e) {
        failures++;
        print(`FAIL ${full}\n     ${e.message}`);
    }
};

// Turn a value into a string for comparison and for error messages.
// JSON.stringify cannot print a Set (it would show {}), so the second argument,
// a "replacer", converts every Set into a sorted list first. `[...x]` is the
// spread syntax: it copies the Set's items into an array. Sorting makes two
// Sets with the same members print identically whatever their insertion order.
function show(v) {
    return JSON.stringify(v, (_k, x) => x instanceof Set ? {set: [...x].sort((a, b) => a - b)} : x);
}

// equal(actual, expected): deep equality by comparing the JSON text of both.
// Works for numbers, strings, arrays, plain objects and Sets (via show()).
// Caveat: object key order matters, and undefined properties are dropped.
globalThis.equal = (actual, expected) => {
    if (show(actual) !== show(expected))
        throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
};

// throws(fn, pattern): passes only if fn() throws. If `pattern` is given, the
// error message must contain it as a substring, so tests can check they failed
// for the intended reason rather than for some unrelated error.
// The explicit `return` after a good catch stops execution before the final
// "expected an exception" line, which is reached only if nothing was thrown.
globalThis.throws = (fn, pattern) => {
    try {
        fn();
    } catch (e) {
        if (pattern && !String(e.message).includes(pattern))
            throw new Error(`threw "${e.message}", expected it to include "${pattern}"`);
        return;
    }
    throw new Error('expected an exception');
};

// Load the test files. Importing a file runs its describe/it calls, so they
// execute here, after the helpers above exist. `await import(...)` is a
// dynamic import (usable at the top level of a module); static `import`
// statements would be hoisted above the helper definitions and run too early.
await import('./keys.test.js');
await import('./layout.test.js');

// print() is gjs's console output. Exit code 1 makes `make test` (and any
// commit hook or CI) fail when a test failed.
print(`${passed} passed, ${failures} failed`);
System.exit(failures ? 1 : 0);

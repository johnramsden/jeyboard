all:

test:
	gjs -m tests/run.js

.PHONY: all test

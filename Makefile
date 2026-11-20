CC = gcc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -g

BUILD := build
TEST := $(BUILD)/test_global_shuffle

.PHONY: test clean

test: $(TEST)
	./$(TEST)

$(TEST): src/global_shuffle.c src/global_shuffle.h tests/test_global_shuffle.c
	mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -Isrc -o $@ src/global_shuffle.c tests/test_global_shuffle.c

clean:
	rm -rf $(BUILD)

# TRAX core - desktop build for the shared library index.
#
# The same core sources compile for the PSP and the Vita; this Makefile only
# builds the host build and its tests so the scan, cache, gallery and shuffle
# can be verified on a developer machine.
#
#   make            build the library, the test runner and the CLI
#   make test       build and run the acceptance suite
#   make cli        build the manual check (build/trax_index_cli)
#   make clean

# make predefines CC=cc, so ?= would never take effect.  Prefer gcc unless the
# caller names a compiler explicitly (make CC=clang).
ifeq ($(origin CC),default)
CC := gcc
endif
CFLAGS  ?= -std=c11 -O2 -g -Wall -Wextra -Werror -Wshadow \
           -Wstrict-prototypes -Wmissing-prototypes -Wpointer-arith \
           -Wcast-qual -Wwrite-strings -Wvla
CPPFLAGS += -Isrc/core -Isrc/host
LDFLAGS ?=

BUILD   := build

CORE_SRC := \
  src/core/trax_common.c \
  src/core/trax_log.c \
  src/core/trax_platform.c \
  src/core/trax_cue.c \
  src/core/trax_library.c \
  src/core/trax_scan.c \
  src/core/trax_index_cache.c \
  src/core/trax_index.c \
  src/core/trax_gallery.c \
  src/core/trax_shuffle.c

HOST_SRC := src/host/trax_host_posix.c

LIB_SRC  := $(CORE_SRC) $(HOST_SRC)
LIB_OBJ  := $(patsubst src/%.c,$(BUILD)/%.o,$(LIB_SRC))

TEST_SRC := tests/test_main.c tests/test_fixture.c
TEST_OBJ := $(patsubst tests/%.c,$(BUILD)/tests/%.o,$(TEST_SRC))
TEST_BIN := $(BUILD)/trax_tests

CLI_BIN := $(BUILD)/trax_index_cli

.PHONY: all test clean

all: $(TEST_BIN) $(CLI_BIN)

$(BUILD)/%.o: src/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(BUILD)/tests/%.o: tests/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -D_POSIX_C_SOURCE=200809L -c $< -o $@

$(TEST_BIN): $(LIB_OBJ) $(TEST_OBJ)
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

CLI_OBJ := $(BUILD)/tools/trax_index_cli.o

$(BUILD)/tools/%.o: tools/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(CLI_BIN): $(LIB_OBJ) $(CLI_OBJ)
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

test: $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -rf $(BUILD)

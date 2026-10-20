"""Atomic file replacement tolerant of short Windows sharing locks."""
import os
import time


def replace_file(source, destination, timeout=5.0):
    deadline = time.monotonic() + timeout
    delay = .01
    while True:
        try:
            os.replace(source, destination)
            return
        except OSError as error:
            # Readers, indexing, and virus scanners can briefly prevent rename.
            # Keep the previous file intact and retry only Windows lock errors.
            if getattr(error, "winerror", None) not in (5, 32, 33):
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(delay, remaining))
            delay = min(.25, delay * 2)

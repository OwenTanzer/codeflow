"""Control-flow fixture for the function-layer renderer (MOO-71 Commit 7).

Deliberately exercises every construct the layered layout has to survive:
a for loop and a while loop (both produce real back-edges), try/except with
two handlers, continue, break, and two distinct return paths. The `>` in the
while condition and the double quotes in the docstring also exercise the
Mermaid-escape decoding the adapter performs.
"""


def process(items, limit):
    """Walk items, retrying transient failures."""
    total = 0
    for item in items:
        if item is None:
            continue
        try:
            value = parse(item)
        except ValueError:
            record_bad(item)
            continue
        except TimeoutError:
            break
        while value > limit:
            value = value // 2
        total += value
    if total == 0:
        return None
    return total


def straight_line(a, b):
    """No branches, no loops -- the degenerate single-spine case."""
    scaled = a * 2
    shifted = scaled + b
    return shifted

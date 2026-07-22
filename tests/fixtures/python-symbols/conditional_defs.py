import sys

if sys.version_info[0] >= 3:
    def greet():
        return "py3"
else:
    def greet():
        return "py2"


class Widget:
    try:
        def build(self):
            return "primary"
    except NameError:
        def build(self):
            return "fallback"

    for _ in range(1):
        def loop_defined():
            return "from-for-loop"

    with open("x") as f:
        def with_defined():
            return "from-with"

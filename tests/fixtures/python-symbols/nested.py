class Outer:
    class Inner:
        def run(self):
            pass

    def run(self):
        def helper():
            pass
        return helper

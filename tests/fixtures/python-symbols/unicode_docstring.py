def before_unicode():
    return "plain ascii line before"


def has_unicode_docstring(x):
    """Café résumé — a docstring with accented and multi-byte characters: 日本語, emoji 🎉."""
    if x > 0:
        return x * 2
    return -x


def after_unicode():
    return "plain ascii line after"

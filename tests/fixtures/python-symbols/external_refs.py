import requests
from mypackage.other import helper_func


def fetch_data():
    resp = requests.get("https://example.com")
    return helper_func(resp)


def call_undefined():
    return totally_undefined_name()

"""One GPU behind llama-swap serves one model at a time, and a steady stream of requests for one model starves the
other (a judge request on `fast` waited over 30 minutes behind `daily` extraction). A job on the second model holds
work/fast.lock (touched as it goes); the jobs on `daily` (harness/gpu_lock.mjs) wait while it is fresh."""
import contextlib, os, time

LOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'work', 'fast.lock')


def touch():
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    with open(LOCK, 'w') as f:
        f.write(f'{os.getpid()} {time.time()}')


@contextlib.contextmanager
def holding():
    touch()
    try:
        yield
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(LOCK)

"""Recover stopped local sessions without disturbing a live trainer."""
import os
from pathlib import Path


RESUMABLE_SETTINGS = frozenset({
    'generations', 'games_per_generation', 'environments', 'workers',
    'candidates', 'cheap_candidates', 'batch_size', 'value_batch_size',
    'updates', 'eval_pairs', 'eval_every', 'device', 'amp',
    'external_ai_enabled', 'external_ai_fraction', 'external_ai_nodes',
    'external_ai_eval_pairs', 'external_ai_command', 'external_ai_options',
    'external_ai_weights', 'external_ai_timeout',
    'external_ai_save_teacher',
})


def validate_continuation(config, saved):
    changed = sorted(key for key in config.keys() | saved.keys()
                     if key not in RESUMABLE_SETTINGS and config.get(key) != saved.get(key))
    if changed:
        raise ValueError(f'Continuation must preserve training settings and rules outside the editable settings: {changed}')


def process_alive(pid):
    if pid <= 0:
        return True
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87  # Access denied is not proof of death.
        try:
            return kernel.WaitForSingleObject(handle, 0) != 0
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def prepare_resume(run):
    run = Path(run)
    lock = run/'RUNNING'
    try:
        content = lock.read_bytes()
    except FileNotFoundError:
        content = None
    if content is not None:
        try:
            pid = int(content)
        except ValueError:
            raise ValueError('RUNNING has an unknown owner; verify the session before removing it')
        if process_alive(pid):
            raise ValueError(f'Training is still running (PID {pid})')
        if lock.read_bytes() != content:
            raise ValueError('RUNNING changed while checking its owner')
        lock.unlink()
    (run/'STOP').unlink(missing_ok=True)

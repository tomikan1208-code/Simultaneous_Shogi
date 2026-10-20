import ctypes
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from training.common import ROOT, atomic_json, read_json
from training.storage import replace_file
from dashboard.recover_io import verify_sources, source_hash


class StorageTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.cache/tests').mkdir(parents=True, exist_ok=True)

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows sharing lock')
    def test_atomic_status_waits_for_reader_without_delete_sharing(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                      ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as folder:
            target = Path(folder) / 'status.json'
            atomic_json(target, {'generation': 50})
            handle = kernel.CreateFileW(str(target), 0x80000000, 3, None, 3, 0x80, None)
            self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
            released = threading.Event()
            def release():
                time.sleep(.15)
                kernel.CloseHandle(handle)
                released.set()
            reader = threading.Thread(target=release)
            reader.start()
            try:
                started = time.monotonic()
                atomic_json(target, {'generation': 51})
                self.assertTrue(released.is_set())
                self.assertGreaterEqual(time.monotonic() - started, .14)
                self.assertEqual(read_json(target), {'generation': 51})
            finally:
                reader.join()

    def test_permanent_lock_has_deadline_and_preserves_previous_json(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as folder:
            target, pending = Path(folder) / 'status.json', Path(folder) / 'status.json.tmp'
            target.write_text('{"generation":50}')
            pending.write_text('{"generation":51}')
            error = PermissionError('simulated Windows sharing lock')
            error.winerror = 5
            with patch('training.storage.os.replace', side_effect=error) as replace:
                started = time.monotonic()
                with self.assertRaises(PermissionError):
                    replace_file(pending, target, timeout=.04)
                self.assertGreater(replace.call_count, 1)
                self.assertLess(time.monotonic() - started, .5)
            self.assertEqual(json.loads(target.read_text()), {'generation': 50})
            self.assertTrue(pending.exists())

    def test_unrelated_file_errors_are_not_retried(self):
        with patch('training.storage.os.replace', side_effect=FileNotFoundError('missing')) as replace:
            with self.assertRaises(FileNotFoundError):
                replace_file('missing', 'target')
            self.assertEqual(replace.call_count, 1)

    def test_recovery_accepts_only_audited_io_change(self):
        previous = {'training/common.py': b'import os\ndef save(a,b):\n os.replace(a,b)\n',
                    'training/config.json': b'{"generations":0}'}
        current = dict(previous, **{'training/storage.py': b'# file retry helper\n',
                       'training/common.py': b'import os\nfrom .storage import replace_file\ndef save(a,b):\n replace_file(a,b)\n'})
        expected = source_hash(previous)
        self.assertEqual(verify_sources(previous, current, expected), ['training/common.py'])
        with self.assertRaises(ValueError):
            verify_sources(previous, current, 'wrong-source')
        with self.assertRaises(ValueError):
            verify_sources(previous, dict(current, **{'training/config.json': b'{"generations":20}'}), expected)
        with self.assertRaises(ValueError):
            verify_sources(previous, dict(current, **{'training/common.py': current['training/common.py'] + b'x=42\n'}), expected)


if __name__ == '__main__':
    unittest.main()

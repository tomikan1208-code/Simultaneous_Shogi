"""Local dashboard health check, including an actual CUDA operation."""
import json
import platform
import sys


def inspect():
    result = {"python": sys.executable, "python_version": platform.python_version(),
              "ready": False, "cuda_available": False, "gpu": None, "error": None}
    try:
        import torch
        result.update(torch=torch.__version__, cuda=torch.version.cuda)
        # is_available alone does not catch unsupported GPU architectures / DLLs.
        if torch.cuda.is_available():
            with torch.inference_mode():
                x = torch.ones((16, 16), device="cuda")
                assert float((x @ x)[0, 0].cpu()) == 16.
            properties = torch.cuda.get_device_properties(0)
            result.update(cuda_available=True, gpu=properties.name,
                          memory_gb=round(properties.total_memory / 1024**3, 1))
        result["ready"] = True
    except Exception as error:
        result["error"] = str(error)
    return result


if __name__ == "__main__":
    print(json.dumps(inspect(), ensure_ascii=False))

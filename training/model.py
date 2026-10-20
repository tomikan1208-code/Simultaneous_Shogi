import contextlib
import numpy as np
import torch
from torch import nn
from .features import PLANES, ACTION_FEATURES


class Net(nn.Module):
    def __init__(self, channels=32):
        super().__init__()
        self.channels = channels
        self.input = nn.Sequential(nn.Conv2d(PLANES, channels, 3, padding=1), nn.SiLU())
        self.residual = nn.Sequential(nn.Conv2d(channels, channels, 3, padding=1), nn.SiLU(), nn.Conv2d(channels, channels, 3, padding=1))
        self.value_head = nn.Sequential(nn.Flatten(), nn.Linear(channels * 81, channels), nn.SiLU(), nn.Linear(channels, 1), nn.Tanh())
        self.policy_head = nn.Sequential(nn.Linear(channels * 3 + ACTION_FEATURES, channels * 2), nn.SiLU(), nn.Linear(channels * 2, 1))

    def encode(self, board):
        x = self.input(board)
        x = torch.nn.functional.silu(x + self.residual(x))
        return x, self.value_head(x).flatten()

    def policy(self, x, owners, indices, descriptors):
        spatial = x.flatten(2).transpose(1, 2)
        start = spatial[owners, indices[:, 0]]
        end = spatial[owners, indices[:, 1]]
        pooled = x.mean((2, 3))[owners]
        return self.policy_head(torch.cat([pooled, start, end, descriptors], 1)).flatten()


def device_for(config):
    choice = config["device"]
    if choice == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDAを使用できません。ローカルでは dashboard/setup-gpu.bat を実行してください。ColabではGPUランタイムを選択してください。")
    return torch.device("cuda" if choice == "cuda" or choice == "auto" and torch.cuda.is_available() else "cpu")


def autocast(device, enabled):
    return torch.autocast("cuda", dtype=torch.float16) if enabled and device.type == "cuda" else contextlib.nullcontext()


def pack(samples, device):
    boards = torch.as_tensor(np.stack([s["board"] for s in samples]), dtype=torch.float32, device=device)
    counts = [len(s["data"]) for s in samples]
    owners = torch.repeat_interleave(torch.arange(len(samples), device=device), torch.tensor(counts, device=device), output_size=sum(counts))
    indices = torch.as_tensor(np.concatenate([s["indices"] for s in samples]), dtype=torch.long, device=device)
    data = torch.as_tensor(np.concatenate([s["data"] for s in samples]), dtype=torch.float32, device=device)
    return boards, owners, indices, data, counts


def segmented_policy_loss(logits, targets, owners, sample_count):
    """Mean per-position cross entropy over ragged complete action sets.

    A single segmented log-sum-exp replaces one softmax/autograd graph per
    position. Detaching the stabilizing maxima preserves the exact gradient.
    """
    logits = logits.float()
    maxima = logits.new_full((sample_count,), -torch.inf)
    maxima.scatter_reduce_(0, owners, logits.detach(), reduce="amax", include_self=True)
    shifted = logits - maxima[owners]
    sums = logits.new_zeros(sample_count).scatter_add_(0, owners, shifted.exp())
    return -(targets * (shifted - sums.log()[owners])).sum() / sample_count


@torch.inference_mode()
def predict(model, samples, device, amp=False):
    if not samples:
        return [], np.empty(0)
    boards, owners, indices, data, counts = pack(samples, device)
    with autocast(device, amp):
        x, values = model.encode(boards)
        logits = model.policy(x, owners, indices, data)
    return list(np.split(logits.float().cpu().numpy(), np.cumsum(counts)[:-1])), values.float().cpu().numpy()

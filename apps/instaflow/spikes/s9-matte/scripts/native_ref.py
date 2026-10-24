# Native ORT CPU reference: peak RSS + latency of one inference (is the model wasm32-feasible?).
# usage: python -I native_ref.py <model.onnx> <H> <W> [threads] [--lowmem]
import sys, time, resource, numpy as np, onnxruntime as ort
p, h, w = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
so = ort.SessionOptions(); so.intra_op_num_threads = int(sys.argv[4]) if len(sys.argv) > 4 else 4
if '--lowmem' in sys.argv: so.enable_cpu_mem_arena = False; so.enable_mem_pattern = False
t = time.time(); s = ort.InferenceSession(p, so, providers=['CPUExecutionProvider']); tl = time.time() - t
x = np.random.rand(1, 3, h, w).astype(np.float32)
t = time.time(); s.run(None, {s.get_inputs()[0].name: x}); t1 = time.time() - t
t = time.time(); s.run(None, {s.get_inputs()[0].name: x}); t2 = time.time() - t
print(f"{p.split('/')[-1]}: load {tl:.1f}s run1 {t1:.1f}s run2 {t2:.1f}s peakRSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024:.0f} MB")

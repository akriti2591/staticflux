# Rewrite a model so no single op binds more than MAX storage buffers (WebGPU maxStorageBuffersPerShaderStage
# is 8 by default, 10 on SwiftShader): Split with many outputs -> Slices; Concat with many inputs -> Concat tree.
# Then check numerical equivalence on ORT CPU.
# usage: python -I webgpu_safe.py <in.onnx> <out.onnx> [--check H W]
import sys, numpy as np, onnx
from onnx import helper, numpy_helper

MAX_IN = 7  # inputs per Concat node (+1 output = 8 buffers)
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
inits = {t.name: t for t in g.initializer}
consts = {n.output[0]: n for n in g.node if n.op_type == 'Constant'}

def const_value(name):
    if name in inits: return numpy_helper.to_array(inits[name])
    if name in consts: return numpy_helper.to_array(consts[name].attribute[0].t)
    raise KeyError(name)

uid = [0]
def fresh(p): uid[0] += 1; return f'{p}__wgs{uid[0]}'
def add_init(arr, p):
    n = fresh(p); g.initializer.append(numpy_helper.from_array(np.asarray(arr, dtype=np.int64), n)); return n

new_nodes, n_split, n_concat = [], 0, 0
for node in g.node:
    if node.op_type == 'Split' and len(node.output) > MAX_IN:
        axis = next((a.i for a in node.attribute if a.name == 'axis'), 0)
        sizes = const_value(node.input[1]).tolist() if len(node.input) > 1 and node.input[1] else None
        if sizes is None: new_nodes.append(node); continue
        start = 0
        for out, sz in zip(node.output, sizes):
            new_nodes.append(helper.make_node('Slice', [node.input[0], add_init([start], 's'), add_init([start + sz], 'e'), add_init([axis], 'a')], [out], name=fresh('slice')))
            start += sz
        n_split += 1
    elif node.op_type == 'Concat' and len(node.input) > MAX_IN:
        axis = next(a.i for a in node.attribute if a.name == 'axis')
        level = list(node.input)
        while len(level) > MAX_IN:
            nxt = []
            for i in range(0, len(level), MAX_IN):
                chunk = level[i:i + MAX_IN]
                if len(chunk) == 1: nxt.append(chunk[0]); continue
                o = fresh('cat'); new_nodes.append(helper.make_node('Concat', chunk, [o], axis=axis, name=fresh('concat'))); nxt.append(o)
            level = nxt
        new_nodes.append(helper.make_node('Concat', level, list(node.output), axis=axis, name=node.name))
        n_concat += 1
    else:
        new_nodes.append(node)
del g.node[:]
g.node.extend(new_nodes)
onnx.save(m, dst)
print(f'rewrote {n_split} Split and {n_concat} Concat nodes -> {dst}')

if '--check' in sys.argv:
    import onnxruntime as ort
    i = sys.argv.index('--check'); h, w = int(sys.argv[i + 1]), int(sys.argv[i + 2])
    so = ort.SessionOptions(); so.enable_cpu_mem_arena = False
    x = np.random.RandomState(0).rand(1, 3, h, w).astype(np.float32)
    a = ort.InferenceSession(src, so).run(None, {'input_image': x})[0]
    b = ort.InferenceSession(dst, so).run(None, {'input_image': x})[0]
    print('max |diff| =', float(np.abs(a - b).max()))

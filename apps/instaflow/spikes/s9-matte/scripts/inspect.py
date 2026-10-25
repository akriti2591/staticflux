# Print I/O shapes, opset and op histogram of ONNX models (args: paths).
import sys, onnx, collections
for p in sys.argv[1:]:
    m = onnx.load(p, load_external_data=False)
    io = lambda vs: [(v.name, [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]) for v in vs]
    ops = collections.Counter(n.op_type for n in m.graph.node)
    print(p.split('/')[-1], 'opset', [(o.domain, o.version) for o in m.opset_import], 'in', io(m.graph.input), 'out', io(m.graph.output)[:3], 'nodes', sum(ops.values()))
    print('   rare ops:', {k: v for k, v in ops.items() if k in ('DeformConv','GridSample','Einsum','Resize','ScatterND','Loop','If','NonZero','Upsample','Pad','RoiAlign')})

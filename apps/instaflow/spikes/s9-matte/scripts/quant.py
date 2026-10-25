# int8 attempt 2: ORT quant_pre_process (constant folding / shape inference) then dynamic quantisation.
# usage: python -I quant.py <in.onnx> <out.onnx>
import sys, time
from onnxruntime.quantization import quantize_dynamic, QuantType
from onnxruntime.quantization.shape_inference import quant_pre_process
src, dst = sys.argv[1:3]
t = time.time()
quant_pre_process(src, dst + '.pre.onnx', skip_symbolic_shape=True)
quantize_dynamic(dst + '.pre.onnx', dst, weight_type=QuantType.QUInt8, op_types_to_quantize=['MatMul', 'Conv'], per_channel=False)
print('ok', round(time.time() - t, 1), 's')

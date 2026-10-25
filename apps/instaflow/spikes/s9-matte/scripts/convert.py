# Make fp16 (keep fp32 I/O) and dynamic-int8 variants of an ONNX model.
# usage: python -I convert.py <in.onnx> <out_prefix> [fp16] [int8]
import sys, time, onnx
src, prefix, *kinds = sys.argv[1:]
if 'fp16' in kinds:
    from onnxconverter_common import float16
    t = time.time(); m = onnx.load(src)
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=True)
    onnx.save(m16, prefix + '_fp16.onnx'); print('fp16 ok', round(time.time() - t, 1), 's', flush=True)
if 'int8' in kinds:
    from onnxruntime.quantization import quantize_dynamic, QuantType
    t = time.time()
    quantize_dynamic(src, prefix + '_int8.onnx', weight_type=QuantType.QUInt8, op_types_to_quantize=['MatMul', 'Gemm'])
    print('int8 ok', round(time.time() - t, 1), 's', flush=True)

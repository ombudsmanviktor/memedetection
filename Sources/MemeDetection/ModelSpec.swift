import Foundation

/// Leitura mínima do protobuf do Core ML (Model.proto), só o necessário para
/// separar o pipeline do Create ML em suas duas etapas:
///   models[0] — VisionFeaturePrint_Scene (extrator de 2048 features, embutido no macOS)
///   models[1] — GLMClassifier (regressão logística com os pesos treinados por Bohacek)
/// Com os pesos em mãos, o app calcula o log-odds em Double, sem a saturação
/// das probabilidades em Float que o pipeline devolve (1.0 contra 1e-12).
struct ProtoReader {
    enum Value { case varint(UInt64), bytes(Data), fixed64(Data), fixed32(Data) }
    struct ParseError: Error {}

    static func fields(_ d: Data) throws -> [(Int, Value)] {
        let b = [UInt8](d)
        var i = 0, out: [(Int, Value)] = []
        func varint() throws -> UInt64 {
            var r: UInt64 = 0, s: UInt64 = 0
            while true {
                guard i < b.count, s < 64 else { throw ParseError() }
                let c = b[i]; i += 1
                r |= UInt64(c & 0x7F) << s; s += 7
                if c < 0x80 { return r }
            }
        }
        while i < b.count {
            let key = try varint()
            let field = Int(key >> 3)
            switch key & 7 {
            case 0: out.append((field, .varint(try varint())))
            case 1:
                guard i + 8 <= b.count else { throw ParseError() }
                out.append((field, .fixed64(Data(b[i..<i + 8])))); i += 8
            case 2:
                let n = Int(try varint())
                guard n >= 0, i + n <= b.count else { throw ParseError() }
                out.append((field, .bytes(Data(b[i..<i + n])))); i += n
            case 5:
                guard i + 4 <= b.count else { throw ParseError() }
                out.append((field, .fixed32(Data(b[i..<i + 4])))); i += 4
            default: throw ParseError()
            }
        }
        return out
    }

    static func bytes(_ fs: [(Int, Value)], _ field: Int) -> [Data] {
        fs.compactMap { f, v in if f == field, case .bytes(let d) = v { return d }; return nil }
    }

    static func doubles(_ d: Data) -> [Double] {
        stride(from: 0, to: d.count - 7, by: 8).map { off in
            Double(bitPattern: d.subdata(in: d.startIndex + off ..< d.startIndex + off + 8)
                .withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) }.littleEndian)
        }
    }
}

struct GLMHead {
    let featureModel: Data      // Model serializado da etapa VisionFeaturePrint
    let weights: [Double]       // 2048 pesos
    let bias: Double
    let labels: [String]        // ["meme", "photo"]
    /// Com uma única linha de pesos (ReferenceClass), sigmoid(w·f + b) é a
    /// probabilidade de labels[1]. Verificado contra a saída do pipeline.
    var memeSign: Double { labels.count > 1 && labels[1] == "meme" ? 1 : -1 }

    static func extract(from model: Data) throws -> GLMHead {
        let top = try ProtoReader.fields(model)
        guard let pipeClf = ProtoReader.bytes(top, 200).first,                         // pipelineClassifier
              let pipeline = ProtoReader.bytes(try ProtoReader.fields(pipeClf), 1).first // pipeline
        else { throw ProtoReader.ParseError() }
        let models = ProtoReader.bytes(try ProtoReader.fields(pipeline), 1)
        guard models.count == 2,
              let glm = ProtoReader.bytes(try ProtoReader.fields(models[1]), 400).first  // glmClassifier
        else { throw ProtoReader.ParseError() }
        let g = try ProtoReader.fields(glm)
        let rows = ProtoReader.bytes(g, 1)                                              // weights: DoubleArray
        guard rows.count == 1, let packed = ProtoReader.bytes(try ProtoReader.fields(rows[0]), 1).first
        else { throw ProtoReader.ParseError() }
        let weights = ProtoReader.doubles(packed)
        var bias = 0.0
        for (f, v) in g where f == 2 {                                                  // offset
            if case .bytes(let d) = v { bias = ProtoReader.doubles(d).first ?? 0 }
            if case .fixed64(let d) = v { bias = ProtoReader.doubles(d).first ?? 0 }
        }
        var labels: [String] = []
        if let sv = ProtoReader.bytes(g, 100).first {                                   // stringClassLabels
            labels = ProtoReader.bytes(try ProtoReader.fields(sv), 1).compactMap { String(data: $0, encoding: .utf8) }
        }
        guard weights.count == 2048, labels.contains("meme") else { throw ProtoReader.ParseError() }
        return GLMHead(featureModel: models[0], weights: weights, bias: bias, labels: labels)
    }

    func logitMeme(_ features: [Double]) -> Double {
        var z = bias
        for i in 0..<min(features.count, weights.count) { z += weights[i] * features[i] }
        return memeSign * z
    }
}

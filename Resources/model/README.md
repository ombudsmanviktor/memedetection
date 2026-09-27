# Modelo: meme-detection 1.0 (Matyáš Boháček, 2020)

`meme-detection.mlmodel` é o classificador **meme × foto** publicado em
[maty-bohacek/meme-detection](https://github.com/maty-bohacek/meme-detection), sob GPL-2.0.

## Procedência: por que este arquivo, e não o do HEAD

O repositório original tem dois `.mlmodel` no histórico:

| Commit | Tamanho | O que é |
|---|---|---|
| `de6affb` "Add model" | 17 129 bytes | **Classificador de imagens**: entrada `image` (299×299), rótulos `meme` e `photo`. É este arquivo. |
| `04610c6` "Update the description" (HEAD) | 372 969 bytes | Classificador de **texto** (`MLTextClassifier`): entrada `text`, rótulos `negative`, `positive`, `neutral`. Não serve para imagens e parece ter sido enviado por engano. |

SHA-256 deste arquivo: `fabd56d389880cc83cc8e9fb64d134c9f7f47d6c8339ecec8b9191ec84c5d77c`

```bash
git clone https://github.com/maty-bohacek/meme-detection && cd meme-detection
git show de6affb:meme-detection.mlmodel | shasum -a 256
```

## Estrutura

O arquivo é um pipeline do Create ML (macOS 10.15.3) com duas etapas:

1. **`VisionFeaturePrint_Scene`** (revisão 1). É o extrator de features da Apple e **não está dentro do arquivo**: vem embutido no macOS e no iOS, e por isso o modelo só roda no Core ML da Apple. Recebe a imagem de 299×299 e devolve um vetor `sceneprint` com 2048 valores.
2. **`GLMClassifier`**. Uma regressão logística com 2048 pesos e um intercepto, treinada pelo autor com alguns milhares de imagens anotadas. O autor declara 100% de acurácia de treino e **91% de validação**. A acurácia de teste não foi publicada.

## Como o MemeDetection usa o modelo

- O `.mlmodel` é compilado em tempo de execução com `MLModel.compileModel(at:)`, numa pasta temporária apagada ao sair. Não precisa de Xcode.
- A imagem é lida com a orientação EXIF aplicada (primeiro quadro, no caso de GIF) e esticada para 299×299 (*scale fill*), sem cortar as bordas, onde memes costumam ter texto. Imagens transparentes recebem fundo branco.
- O pipeline devolve probabilidades em Float muito saturadas, como 1,0 contra 1e-12. Por isso o app separa as duas etapas: roda só o `VisionFeaturePrint_Scene`, lê os pesos do GLM direto do protobuf e calcula o **log-odds** `z = w·f + b` em Double. A probabilidade `P(meme) = 1/(1+e^-z)` é idêntica à do pipeline, e o log-odds dá resolução útil para comparar imagens e medir confiança. Se a separação falhar, o app usa o pipeline inteiro.
- Pela convenção do Core ML para GLM binário, `sigmoid(w·f + b)` é a probabilidade do segundo rótulo (`photo`). O log-odds de meme é, portanto, `-(w·f + b)`. Isso foi conferido contra a saída do pipeline.

## Reprodutibilidade

- No **mesmo Mac**, execuções repetidas dão resultados idênticos.
- Entre **Macs diferentes** (Apple Silicon × Intel) ou versões do macOS, a rede `VisionFeaturePrint_Scene` pode gerar features um pouco diferentes. Nos testes, o log-odds variou até cerca de 1 unidade. Os rótulos só mudam para imagens muito próximas do limiar, que já aparecem com `md_nivel_confianca = baixa`.

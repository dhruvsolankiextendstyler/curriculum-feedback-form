import Sentiment from 'sentiment'
import { createClassifier } from './sentiment'

const classifier = createClassifier(new Sentiment())

self.onmessage = (e) => {
  self.postMessage(classifier.summarise(e.data))
}

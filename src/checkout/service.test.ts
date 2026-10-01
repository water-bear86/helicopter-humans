import { serviceContract } from './test-support'
import { MemoryOrderStore } from './store'

serviceContract('memory store', () => new MemoryOrderStore())

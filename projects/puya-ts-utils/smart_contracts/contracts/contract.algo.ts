import { Contract } from '@algorandfoundation/algorand-typescript'

export class Contracts extends Contract {
  hello(name: string): string {
    return `Hello, ${name}`
  }
}

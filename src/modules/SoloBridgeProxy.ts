/*

    Copyright 2020 dYdX Trading Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

*/

import BigNumber from 'bignumber.js';
import Web3 from 'web3';
import { Contract } from 'web3-eth-contract';

import { Contracts } from './Contracts';
import { hashString, addressToBytes32, bnToBytes32, boolToBytes32 } from '../lib/BytesHelper';
import {
  EIP712_DOMAIN_STRING,
  EIP712_DOMAIN_STRUCT,
  SIGNATURE_TYPES,
  createTypedSignature,
  ethSignTypedDataInternal,
  getEIP712Hash,
  signatureToSolidityStruct,
  hashHasValidSignature,
} from '../lib/SignatureHelper';
import {
  BigNumberable,
  SendOptions,
  SoloBridgeTransfer,
  SignedSoloBridgeTransfer,
  TxResult,
  TypedSignature,
  address,
  SigningMethod,
} from '../lib/types';

const EIP712_DOMAIN_NAME = 'P1SoloBridgeProxy';
const EIP712_DOMAIN_VERSION = '1.0';
const EIP712_TRANSFER_STRUCT_STRING =
  'Transfer(' +
  'address account,' +
  'address perpetual,' +
  'uint256 soloAccountNumber,' +
  'uint256 soloMarketId,' +
  'bool toPerpetual,' +
  'uint256 amount,' +
  'uint256 expiration,' +
  'bytes32 salt' +
  ')';

const EIP712_TRANSFER_STRUCT = [
  { type: 'address', name: 'account' },
  { type: 'address', name: 'perpetual' },
  { type: 'uint256', name: 'soloAccountNumber' },
  { type: 'uint256', name: 'soloMarketId' },
  { type: 'bool', name: 'toPerpetual' },
  { type: 'uint256', name: 'amount' },
  { type: 'uint256', name: 'expiration' },
  { type: 'bytes32', name: 'salt' },
];

export class SoloBridgeProxy {
  private contracts: Contracts;
  private web3: Web3;
  private proxy: Contract;

  constructor(
    contracts: Contracts,
    web3: Web3,
  ) {
    this.contracts = contracts;
    this.web3 = web3;
    this.proxy = this.contracts.p1SoloBridgeProxy;
  }

  get address(): address {
    return this.contracts.p1SoloBridgeProxy.options.address;
  }

  // ============ State-Changing Functions ============

  public async approveMaximumOnSolo(
    soloMarketId: BigNumberable,
    options?: SendOptions,
  ): Promise<TxResult> {
    return this.contracts.send(
      this.proxy.methods.approveMaximumOnSolo(
        new BigNumber(soloMarketId).toFixed(0),
      ),
      options,
    );
  }

  public async approveMaximumOnPerpetual(
    options?: SendOptions,
  ): Promise<TxResult> {
    return this.contracts.send(
      this.proxy.methods.approveMaximumOnPerpetual(
        this.contracts.perpetualProxy.options.address,
      ),
      options,
    );
  }

  public async bridgeTransfer(
    transfer: SoloBridgeTransfer | SignedSoloBridgeTransfer,
    options?: SendOptions,
  ): Promise<TxResult> {
    let signature: TypedSignature = `0x${'0'.repeat(130)}`;
    if ((transfer as SignedSoloBridgeTransfer).typedSignature) {
      signature = (transfer as SignedSoloBridgeTransfer).typedSignature;
    }
    return this.contracts.send(
      this.proxy.methods.bridgeTransfer(
        this.transferToSolidity(transfer),
        signatureToSolidityStruct(signature),
      ),
      options,
    );
  }

  public async cancelTransfer(
    transfer: SoloBridgeTransfer,
    options?: SendOptions,
  ): Promise<TxResult> {
    return this.contracts.send(
      this.proxy.methods.cancelTransfer(
        this.transferToSolidity(transfer),
      ),
      options,
    );
  }

  // ============ Signing Methods ============

  public async getSignedTransfer(
    transfer: SoloBridgeTransfer,
    signingMethod: SigningMethod,
  ): Promise<SignedSoloBridgeTransfer> {
    const typedSignature = await this.signTransfer(transfer, signingMethod);
    return {
      ...transfer,
      typedSignature,
    };
  }

  /**
   * Sends transfer to current provider for signing. Can sign locally if the signing account is
   * loaded into web3 and SigningMethod.Hash is used.
   */
  public async signTransfer(
    transfer: SoloBridgeTransfer,
    signingMethod: SigningMethod,
  ): Promise<TypedSignature> {
    switch (signingMethod) {
      case SigningMethod.Hash:
      case SigningMethod.UnsafeHash:
      case SigningMethod.Compatibility:
        const transferHash = this.getTransferHash(transfer);
        const rawSignature = await this.web3.eth.sign(transferHash, transfer.account);
        const hashSig = createTypedSignature(rawSignature, SIGNATURE_TYPES.DECIMAL);
        if (signingMethod === SigningMethod.Hash) {
          return hashSig;
        }
        const unsafeHashSig = createTypedSignature(rawSignature, SIGNATURE_TYPES.NO_PREPEND);
        if (signingMethod === SigningMethod.UnsafeHash) {
          return unsafeHashSig;
        }
        if (hashHasValidSignature(transferHash, unsafeHashSig, transfer.account)) {
          return unsafeHashSig;
        }
        return hashSig;

      case SigningMethod.TypedData:
      case SigningMethod.MetaMask:
      case SigningMethod.MetaMaskLatest:
      case SigningMethod.CoinbaseWallet:
        return this.ethSignTypedTransferInternal(
          transfer,
          signingMethod,
        );

      default:
        throw new Error(`Invalid signing method ${signingMethod}`);
    }
  }

  // ============ Signature Verification ============

  /**
   * Check whether the transfer has a valid signature from the account specified in the transfer.
   */
  public transferHasValidSignature(
    transfer: SignedSoloBridgeTransfer,
  ): boolean {
    return hashHasValidSignature(
      this.getTransferHash(transfer),
      transfer.typedSignature,
      transfer.account,
    );
  }

  // ============ Hashing Functions ============

  /**
   * Returns the final signable EIP712 hash for approving a transfer.
   */
  public getTransferHash(
    transfer: SoloBridgeTransfer,
  ): string {
    if (typeof transfer.expiration === 'undefined' || typeof transfer.salt === 'undefined') {
      throw new Error(
        'Must specify expiration and salt for the transfer before it can be hashed or signed',
      );
    }

    const structHash = Web3.utils.soliditySha3(
      { t: 'bytes32', v: hashString(EIP712_TRANSFER_STRUCT_STRING) },
      { t: 'bytes32', v: addressToBytes32(transfer.account) },
      { t: 'bytes32', v: addressToBytes32(transfer.perpetual) },
      { t: 'uint256', v: new BigNumber(transfer.soloAccountNumber).toFixed(0) },
      { t: 'uint256', v: new BigNumber(transfer.soloMarketId).toFixed(0) },
      { t: 'bytes32', v: boolToBytes32(transfer.toPerpetual) },
      { t: 'uint256', v: new BigNumber(transfer.amount).toFixed(0) },
      { t: 'uint256', v: new BigNumber(transfer.expiration).toFixed(0) },
      { t: 'bytes32', v: bnToBytes32(transfer.salt) },
    );
    return getEIP712Hash(this.getDomainHash(), structHash);
  }

  /**
   * Returns the EIP712 domain separator hash.
   */
  public getDomainHash(): string {
    return Web3.utils.soliditySha3(
      { t: 'bytes32', v: hashString(EIP712_DOMAIN_STRING) },
      { t: 'bytes32', v: hashString(EIP712_DOMAIN_NAME) },
      { t: 'bytes32', v: hashString(EIP712_DOMAIN_VERSION) },
      { t: 'uint256', v: `${this.contracts.networkId}` },
      { t: 'bytes32', v: addressToBytes32(this.address) },
    );
  }

  // ============ Private Helper Functions ============

  private transferToSolidity(
    transfer: SoloBridgeTransfer,
  ): any {
    return {
      account: transfer.account,
      perpetual: transfer.perpetual,
      soloAccountNumber: new BigNumber(transfer.soloAccountNumber).toFixed(0),
      soloMarketId: new BigNumber(transfer.soloMarketId).toFixed(0),
      toPerpetual: transfer.toPerpetual,
      amount: new BigNumber(transfer.amount).toFixed(0),
      expiration: new BigNumber(transfer.expiration).toFixed(0),
      salt: bnToBytes32(transfer.salt),
    };
  }

  private getDomainData() {
    return {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: this.contracts.networkId,
      verifyingContract: this.address,
    };
  }

  private async ethSignTypedTransferInternal(
    transfer: SoloBridgeTransfer,
    signingMethod: SigningMethod,
  ): Promise<TypedSignature> {
    const transferData = this.transferToSolidity(transfer);
    const data = {
      types: {
        EIP712Domain: EIP712_DOMAIN_STRUCT,
        Transfer: EIP712_TRANSFER_STRUCT,
      },
      domain: this.getDomainData(),
      primaryType: 'Transfer',
      message: transferData,
    };
    return ethSignTypedDataInternal(
      this.web3.currentProvider,
      transfer.account,
      data,
      signingMethod,
    );
  }
}

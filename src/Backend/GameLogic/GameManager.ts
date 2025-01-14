import { EventEmitter } from 'events';
import { BigInteger } from 'big-integer';
import {
  ExploredChunkData,
  Rectangle,
  isLocatable,
  HashConfig,
  Wormhole,
  RevealCountdownInfo,
} from '../../_types/global/GlobalTypes';
import PersistentChunkStore from '../Storage/PersistentChunkStore';
import ContractsAPI from './ContractsAPI';
import MinerManager, { HomePlanetMinerChunkStore, MinerManagerEvent } from '../Miner/MinerManager';
import _ from 'lodash';
import {
  ContractConstants,
  ContractsAPIEvent,
  UpgradeArgs,
} from '../../_types/darkforest/api/ContractsAPITypes';
import { fakeHash, mimcHash, perlin } from '@darkforest_eth/hashing';
import { GameObjects } from './GameObjects';
import { getRandomActionId, hexifyBigIntNestedArray } from '../Utils/Utils';
import { Contract, ContractInterface } from 'ethers';
import {
  isUnconfirmedInit,
  isUnconfirmedMove,
  isUnconfirmedUpgrade,
  isUnconfirmedBuyHat,
  isUnconfirmedFindArtifact,
  isUnconfirmedDepositArtifact,
  isUnconfirmedWithdrawArtifact,
  isUnconfirmedProspectPlanet,
  isUnconfirmedDeactivateArtifact,
  isUnconfirmedActivateArtifact,
  isUnconfirmedReveal,
  isUnconfirmedBuyGPTCredits,
  isUnconfirmedWithdrawSilver,
} from '../Utils/TypeAssertions';
import {
  EthAddress,
  Player,
  ArtifactId,
  VoyageId,
  LocationId,
  WorldLocation,
  WorldCoords,
  Conversation,
  PlanetLevel,
  PlanetType,
  SpaceType,
  QueuedArrival,
  Upgrade,
  Planet,
  Artifact,
  UnconfirmedUpgrade,
  EthTxType,
  TxIntent,
  UnconfirmedMove,
  SubmittedTx,
  UnconfirmedInit,
  UnconfirmedPlanetTransfer,
  UnconfirmedFindArtifact,
  UnconfirmedDepositArtifact,
  UnconfirmedWithdrawArtifact,
  UnconfirmedProspectPlanet,
  UnconfirmedActivateArtifact,
  UnconfirmedDeactivateArtifact,
  UnconfirmedReveal,
  UnconfirmedBuyGPTCredits,
  UnconfirmedWithdrawSilver,
  ArtifactType,
  ArtifactRarity,
  RevealedCoords,
  LocatablePlanet,
  RevealedLocation,
} from '@darkforest_eth/types';
import NotificationManager from '../../Frontend/Game/NotificationManager';
import { MIN_CHUNK_SIZE } from '../../Frontend/Utils/constants';
import { monomitter, Monomitter } from '../../Frontend/Utils/Monomitter';
import { TerminalTextStyle } from '../../Frontend/Utils/TerminalTypes';
import UIEmitter from '../../Frontend/Utils/UIEmitter';
import { TerminalHandle } from '../../Frontend/Views/Terminal';
import { MiningPattern, SpiralPattern, SwissCheesePattern } from '../Miner/MiningPatterns';
import EthConnection from '../Network/EthConnection';
import { ThrottledConcurrentQueue } from '../Network/ThrottledConcurrentQueue';
import { getAllTwitters, verifyTwitterHandle } from '../Network/UtilityServerAPI';
import { SerializedPlugin } from '../Plugins/SerializedPlugin';
import { ProcgenUtils } from '../Procedural/ProcgenUtils';
import SnarkArgsHelper from '../Utils/SnarkArgsHelper';
import { isActivated } from './ArtifactUtils';
import stringify from 'json-stable-stringify';
import { getConversation, startConversation, stepConversation } from '../Network/ConversationAPI';
import { address, locationIdToDecStr, locationIdFromBigInt } from '@darkforest_eth/serde';
import UIStateStorageManager, { UIDataKey } from '../Storage/UIStateStorageManager';
import { CORE_CONTRACT_ADDRESS } from '@darkforest_eth/contracts';
import { InitialGameStateDownloader } from './InitialGameStateDownloader';
import { Radii } from './ViewportEntities';

export enum GameManagerEvent {
  PlanetUpdate = 'PlanetUpdate',
  DiscoveredNewChunk = 'DiscoveredNewChunk',
  InitializedPlayer = 'InitializedPlayer',
  InitializedPlayerError = 'InitializedPlayerError',
  ArtifactUpdate = 'ArtifactUpdate',
  Moved = 'Moved',
}
class GameManager extends EventEmitter {
  private readonly terminal: React.MutableRefObject<TerminalHandle | undefined>;
  private readonly account: EthAddress | undefined;
  private readonly players: Map<string, Player>;
  private readonly contractsAPI: ContractsAPI;
  private readonly persistentChunkStore: PersistentChunkStore;
  private readonly snarkHelper: SnarkArgsHelper;
  private readonly entityStore: GameObjects;
  private readonly useMockHash: boolean;
  private readonly contractConstants: ContractConstants;
  private readonly endTimeSeconds: number = 1643587533; // jan 2022
  private readonly ethConnection: EthConnection;
  private readonly hashConfig: HashConfig;
  private readonly planetHashMimc: (...inputs: number[]) => BigInteger;
  private readonly uiStateStorageManager: UIStateStorageManager;

  private balance: number;
  private myBalance$: Monomitter<number>;
  private balanceInterval: ReturnType<typeof setInterval>;
  private minerManager?: MinerManager;
  private hashRate: number;
  private homeLocation: WorldLocation | undefined;
  private worldRadius: number;
  private gptCreditPriceEther: number;
  private gptCreditPriceEtherEmitter$: Monomitter<number>;
  private myGPTCredits: number;
  private myGPTCredits$: Monomitter<number>;

  public get planetRarity(): number {
    return this.contractConstants.PLANET_RARITY;
  }

  private constructor(
    terminal: React.MutableRefObject<TerminalHandle | undefined>,
    account: EthAddress | undefined,
    balance: number,
    players: Map<string, Player>,
    touchedPlanets: Map<LocationId, Planet>,
    allTouchedPlanetIds: Set<LocationId>,
    revealedCoords: Map<LocationId, RevealedCoords>,
    worldRadius: number,
    unprocessedArrivals: Map<VoyageId, QueuedArrival>,
    unprocessedPlanetArrivalIds: Map<LocationId, VoyageId[]>,
    contractsAPI: ContractsAPI,
    contractConstants: ContractConstants,
    persistentChunkStore: PersistentChunkStore,
    snarkHelper: SnarkArgsHelper,
    homeLocation: WorldLocation | undefined,
    useMockHash: boolean,
    artifacts: Map<ArtifactId, Artifact>,
    ethConnection: EthConnection,
    gptCreditPriceEther: number,
    myGPTCredits: number,
    uiStateStorageManager: UIStateStorageManager
  ) {
    super();

    this.terminal = terminal;
    this.account = account;
    this.balance = balance;
    this.myBalance$ = monomitter(true);
    this.myBalance$.publish(balance);
    this.players = players;
    this.worldRadius = worldRadius;
    this.gptCreditPriceEther = gptCreditPriceEther;
    this.myGPTCredits$ = monomitter(true);
    this.gptCreditPriceEtherEmitter$ = monomitter(true);
    this.myGPTCredits = myGPTCredits;
    this.myGPTCredits$.publish(myGPTCredits);
    this.gptCreditPriceEtherEmitter$.publish(gptCreditPriceEther);
    this.uiStateStorageManager = uiStateStorageManager;

    this.hashConfig = {
      planetHashKey: contractConstants.PLANETHASH_KEY,
      spaceTypeKey: contractConstants.SPACETYPE_KEY,
      biomebaseKey: contractConstants.BIOMEBASE_KEY,
      perlinLengthScale: contractConstants.PERLIN_LENGTH_SCALE,
      perlinMirrorX: contractConstants.PERLIN_MIRROR_X,
      perlinMirrorY: contractConstants.PERLIN_MIRROR_Y,
    };
    this.planetHashMimc = useMockHash ? fakeHash : mimcHash(this.hashConfig.planetHashKey);

    this.contractConstants = contractConstants;
    this.homeLocation = homeLocation;

    const revealedLocations = new Map<LocationId, RevealedLocation>();
    for (const [locationId, coords] of revealedCoords) {
      const planet = touchedPlanets.get(locationId);
      if (planet) {
        const location: WorldLocation = {
          hash: locationId,
          coords,
          perlin: planet.perlin,
          biomebase: this.biomebasePerlin(coords, true),
        };
        revealedLocations.set(locationId, { ...location, revealer: coords.revealer });
      }
    }

    this.entityStore = new GameObjects(
      account,
      touchedPlanets,
      allTouchedPlanetIds,
      revealedLocations,
      artifacts,
      persistentChunkStore.allChunks(),
      unprocessedArrivals,
      unprocessedPlanetArrivalIds,
      contractConstants,
      worldRadius
    );

    this.contractsAPI = contractsAPI;
    this.persistentChunkStore = persistentChunkStore;
    this.snarkHelper = snarkHelper;
    this.useMockHash = useMockHash;

    this.ethConnection = ethConnection;

    this.balanceInterval = setInterval(() => {
      if (this.account) {
        ethConnection.getBalance(this.account).then((balance) => {
          this.balance = balance;
          this.myBalance$.publish(balance);
        });
      }
    }, 5000);

    this.hashRate = 0;
  }

  public getEthConnection() {
    return this.ethConnection;
  }

  public destroy(): void {
    // removes singletons of ContractsAPI, LocalStorageManager, MinerManager
    if (this.minerManager) {
      this.minerManager.removeAllListeners(MinerManagerEvent.DiscoveredNewChunk);
      this.minerManager.destroy();
    }
    this.contractsAPI.destroy();
    this.persistentChunkStore.destroy();
    clearInterval(this.balanceInterval);
  }

  static async create(
    ethConnection: EthConnection,
    terminal: React.MutableRefObject<TerminalHandle | undefined>
  ): Promise<GameManager> {
    if (!terminal.current) {
      throw new Error('you must pass in a handle to a terminal');
    }

    const account = ethConnection.getAddress();
    const gameStateDownloader = new InitialGameStateDownloader(terminal.current);
    const uiStateStorageManager = UIStateStorageManager.create(account, CORE_CONTRACT_ADDRESS);
    const contractsAPI = await ContractsAPI.create(ethConnection, uiStateStorageManager, terminal);

    terminal.current?.println('Loading game data from disk...');

    const persistentChunkStore = await PersistentChunkStore.create(account);

    terminal.current?.println(
      'Downloading data from Ethereum blockchain... (the contract is very big. this may take a while)'
    );
    terminal.current?.newline();

    const initialState = await gameStateDownloader.download(contractsAPI, persistentChunkStore);
    const possibleHomes = await persistentChunkStore.getHomeLocations();

    await persistentChunkStore.saveTouchedPlanetIds(initialState.allTouchedPlanetIds);
    await persistentChunkStore.saveRevealedCoords(initialState.allRevealedCoords);

    const knownArtifacts: Map<ArtifactId, Artifact> = new Map();

    for (let i = 0; i < initialState.loadedPlanets.length; i++) {
      const planet = initialState.touchedAndLocatedPlanets.get(initialState.loadedPlanets[i]);

      if (!planet) {
        continue;
      }

      planet.heldArtifactIds = initialState.heldArtifacts[i].map((a) => a.id);

      for (const heldArtifact of initialState.heldArtifacts[i]) {
        knownArtifacts.set(heldArtifact.id, heldArtifact);
      }
    }

    for (const myArtifact of initialState.myArtifacts) {
      knownArtifacts.set(myArtifact.id, myArtifact);
    }

    for (const artifact of initialState.artifactsOnVoyages) {
      knownArtifacts.set(artifact.id, artifact);
    }

    // figure out what's my home planet
    let homeLocation: WorldLocation | undefined = undefined;
    for (const loc of possibleHomes) {
      if (initialState.allTouchedPlanetIds.includes(loc.hash)) {
        homeLocation = loc;
        await persistentChunkStore.confirmHomeLocation(loc);
        break;
      }
    }

    const hashConfig: HashConfig = {
      planetHashKey: initialState.contractConstants.PLANETHASH_KEY,
      spaceTypeKey: initialState.contractConstants.SPACETYPE_KEY,
      biomebaseKey: initialState.contractConstants.BIOMEBASE_KEY,
      perlinLengthScale: initialState.contractConstants.PERLIN_LENGTH_SCALE,
      perlinMirrorX: initialState.contractConstants.PERLIN_MIRROR_X,
      perlinMirrorY: initialState.contractConstants.PERLIN_MIRROR_Y,
    };

    const useMockHash = initialState.contractConstants.DISABLE_ZK_CHECKS;
    const snarkHelper = SnarkArgsHelper.create(hashConfig, terminal, useMockHash);

    const gameManager = new GameManager(
      terminal,
      account,
      initialState.balance,
      initialState.players,
      initialState.touchedAndLocatedPlanets,
      new Set(Array.from(initialState.allTouchedPlanetIds)),
      initialState.revealedCoordsMap,
      initialState.worldRadius,
      initialState.arrivals,
      initialState.planetVoyageIdMap,
      contractsAPI,
      initialState.contractConstants,
      persistentChunkStore,
      snarkHelper,
      homeLocation,
      useMockHash,
      knownArtifacts,
      ethConnection,
      initialState.gptCreditPriceEther,
      initialState.myGPTCredits,
      uiStateStorageManager
    );

    // important that this happens AFTER we load the game state from the blockchain. Otherwise our
    // 'loading game state' contract calls will be competing with events from the blockchain that
    // are happening now, which makes no sense.
    contractsAPI.setupEventListeners();

    // get twitter handles
    gameManager.refreshTwitters();

    // set up listeners: whenever ContractsAPI reports some game state update, do some logic
    gameManager.contractsAPI
      .on(ContractsAPIEvent.ArtifactUpdate, async (artifactId: ArtifactId) => {
        await gameManager.hardRefreshArtifact(artifactId);
        gameManager.emit(GameManagerEvent.ArtifactUpdate, artifactId);
      })
      .on(
        ContractsAPIEvent.PlanetTransferred,
        async (planetId: LocationId, newOwner: EthAddress) => {
          await gameManager.hardRefreshPlanet(planetId);
          const planetAfter = gameManager.getPlanetWithId(planetId);

          if (planetAfter && newOwner === gameManager.account) {
            NotificationManager.getInstance().receivedPlanet(planetAfter);
          }
        }
      )
      .on(ContractsAPIEvent.PlayerUpdate, async (playerId: EthAddress) => {
        await gameManager.hardRefreshPlayer(playerId);
      })
      .on(ContractsAPIEvent.PlanetUpdate, async (planetId: LocationId) => {
        // don't reload planets that you don't have in your map. once a planet
        // is in your map it will be loaded from the contract.
        const localPlanet = gameManager.entityStore.getPlanetWithId(planetId);
        if (localPlanet && isLocatable(localPlanet)) {
          await gameManager.hardRefreshPlanet(planetId);
          gameManager.emit(GameManagerEvent.PlanetUpdate);
        }
      })
      .on(
        ContractsAPIEvent.ArrivalQueued,
        async (_arrivalId: VoyageId, fromId: LocationId, toId: LocationId) => {
          // only reload planets if the toPlanet is in the map
          const localToPlanet = gameManager.entityStore.getPlanetWithId(toId);
          if (localToPlanet && isLocatable(localToPlanet)) {
            const promises = [
              gameManager.hardRefreshPlanet(fromId),
              gameManager.hardRefreshPlanet(toId),
            ];
            await Promise.all(promises);
            gameManager.emit(GameManagerEvent.PlanetUpdate);
          }
        }
      )
      .on(
        ContractsAPIEvent.LocationRevealed,
        async (planetId: LocationId, _revealer: EthAddress) => {
          // TODO: hook notifs or emit event to UI if you want
          await gameManager.hardRefreshPlanet(planetId);
          gameManager.emit(GameManagerEvent.PlanetUpdate);
        }
      )
      .on(ContractsAPIEvent.ChangedGPTCreditPrice, async (newPriceInEther: number) => {
        gameManager.gptCreditPriceEther = newPriceInEther;
        gameManager.gptCreditPriceEtherEmitter$.publish(newPriceInEther);
      })
      .on(ContractsAPIEvent.TxSubmitted, (unconfirmedTx: SubmittedTx) => {
        gameManager.persistentChunkStore.onEthTxSubmit(unconfirmedTx);
      })
      .on(ContractsAPIEvent.TxConfirmed, async (unconfirmedTx: SubmittedTx) => {
        gameManager.persistentChunkStore.onEthTxComplete(unconfirmedTx.txHash);
        if (isUnconfirmedReveal(unconfirmedTx)) {
          const promises = [
            gameManager.hardRefreshPlanet(unconfirmedTx.locationId),
            gameManager.hardRefreshPlayer(account),
          ];
          await Promise.all(promises);
        } else if (isUnconfirmedInit(unconfirmedTx)) {
          gameManager.emit(GameManagerEvent.InitializedPlayer);
          // mining manager should be initialized already via joinGame, but just in case...
          gameManager.initMiningManager(unconfirmedTx.location.coords);
        } else if (isUnconfirmedMove(unconfirmedTx)) {
          const promises = [
            gameManager.hardRefreshPlanet(unconfirmedTx.from),
            gameManager.hardRefreshPlanet(unconfirmedTx.to),
          ];
          if (unconfirmedTx.artifact) {
            promises.push(gameManager.hardRefreshArtifact(unconfirmedTx.artifact));
          }
          await Promise.all(promises);
        } else if (isUnconfirmedUpgrade(unconfirmedTx)) {
          await gameManager.hardRefreshPlanet(unconfirmedTx.locationId);
        } else if (isUnconfirmedBuyHat(unconfirmedTx)) {
          await gameManager.hardRefreshPlanet(unconfirmedTx.locationId);
        } else if (isUnconfirmedInit(unconfirmedTx)) {
          await gameManager.hardRefreshPlanet(unconfirmedTx.locationId);
        } else if (isUnconfirmedFindArtifact(unconfirmedTx)) {
          await gameManager.hardRefreshPlanet(unconfirmedTx.planetId);
        } else if (isUnconfirmedDepositArtifact(unconfirmedTx)) {
          await Promise.all([
            gameManager.hardRefreshPlanet(unconfirmedTx.locationId),
            gameManager.hardRefreshArtifact(unconfirmedTx.artifactId),
          ]);
        } else if (isUnconfirmedWithdrawArtifact(unconfirmedTx)) {
          await Promise.all([
            await gameManager.hardRefreshPlanet(unconfirmedTx.locationId),
            await gameManager.hardRefreshArtifact(unconfirmedTx.artifactId),
          ]);
        } else if (isUnconfirmedProspectPlanet(unconfirmedTx)) {
          await gameManager.hardRefreshPlanet(unconfirmedTx.planetId);
        } else if (isUnconfirmedActivateArtifact(unconfirmedTx)) {
          await Promise.all([
            gameManager.hardRefreshPlanet(unconfirmedTx.locationId),
            gameManager.hardRefreshArtifact(unconfirmedTx.artifactId),
          ]);
        } else if (isUnconfirmedDeactivateArtifact(unconfirmedTx)) {
          await Promise.all([
            gameManager.hardRefreshPlanet(unconfirmedTx.locationId),
            gameManager.hardRefreshArtifact(unconfirmedTx.artifactId),
          ]);
        } else if (isUnconfirmedWithdrawSilver(unconfirmedTx)) {
          await Promise.all([
            gameManager.hardRefreshPlanet(unconfirmedTx.locationId),
            gameManager.hardRefreshPlayer(account),
          ]);
        } else if (isUnconfirmedBuyGPTCredits(unconfirmedTx)) {
          await gameManager.refreshMyGPTCredits();
        }

        gameManager.entityStore.clearUnconfirmedTxIntent(unconfirmedTx);
        if (gameManager.account) {
          gameManager.balance = await gameManager.ethConnection.getBalance(gameManager.account);
          gameManager.myBalance$.publish(gameManager.balance);
        }
      })
      .on(ContractsAPIEvent.TxReverted, async (unconfirmedTx: SubmittedTx) => {
        gameManager.entityStore.clearUnconfirmedTxIntent(unconfirmedTx);
        gameManager.persistentChunkStore.onEthTxComplete(unconfirmedTx.txHash);
        if (gameManager.account) {
          gameManager.balance = await gameManager.ethConnection.getBalance(gameManager.account);
          gameManager.myBalance$.publish(gameManager.balance);
        }
      })
      .on(ContractsAPIEvent.RadiusUpdated, async () => {
        const newRadius = await gameManager.contractsAPI.getWorldRadius();
        gameManager.setRadius(newRadius);
      });

    const unconfirmedTxs = await persistentChunkStore.getUnconfirmedSubmittedEthTxs();
    const confirmationQueue = new ThrottledConcurrentQueue(10, 1000, 1);

    for (const unconfirmedTx of unconfirmedTxs) {
      // recommits the tx to storage but whatever
      gameManager.contractsAPI.waitFor(
        unconfirmedTx,
        confirmationQueue.add(() => ethConnection.waitForTransaction(unconfirmedTx.txHash))
      );
    }

    // we only want to initialize the mining manager if the player has already joined the game
    // if they haven't, we'll do this once the player has joined the game
    if (!!homeLocation && initialState.players.has(account as string)) {
      gameManager.initMiningManager(homeLocation.coords);
    }

    return gameManager;
  }

  private async hardRefreshPlayer(address: EthAddress): Promise<void> {
    const player = await this.contractsAPI.getPlayerById(address);
    if (!player) {
      return;
    }
    const existingPlayerTwitter = this.players.get(address)?.twitter;
    if (existingPlayerTwitter) {
      player.twitter = existingPlayerTwitter;
    }
    this.players.set(address, player);
  }

  private async hardRefreshPlanet(planetId: LocationId): Promise<void> {
    const planet = await this.contractsAPI.getPlanetById(planetId);
    if (!planet) return;
    const arrivals = await this.contractsAPI.getArrivalsForPlanet(planetId);
    const artifactsOnPlanets = await this.contractsAPI.bulkGetArtifactsOnPlanets([planetId]);
    const artifactsOnPlanet = artifactsOnPlanets[0];

    const revealedCoords = await this.contractsAPI.getRevealedCoordsByIdIfExists(planetId);
    let revealedLocation: RevealedLocation | undefined;
    if (revealedCoords) {
      revealedLocation = {
        ...this.locationFromCoords(revealedCoords),
        revealer: revealedCoords.revealer,
      };
    }

    this.entityStore.replacePlanetFromContractData(
      planet,
      arrivals,
      artifactsOnPlanet.map((a) => a.id),
      revealedLocation
    );

    // it's important that we reload the artifacts that are on the planet after the move
    // completes because this move could have been a photoid canon move. one of the side
    // effects of this type of move is that the active photoid canon deactivates upon a move
    // meaning we need to reload its data from the blockchain.
    artifactsOnPlanet.forEach((a) => this.entityStore.replaceArtifactFromContractData(a));
  }

  private async bulkHardRefreshPlanets(planetIds: LocationId[]): Promise<void> {
    const planetVoyageMap: Map<LocationId, QueuedArrival[]> = new Map();

    const allVoyages = await this.contractsAPI.getAllArrivals(planetIds);
    const planetsToUpdateMap = await this.contractsAPI.bulkGetPlanets(planetIds);
    const artifactsOnPlanets = await this.contractsAPI.bulkGetArtifactsOnPlanets(planetIds);

    planetsToUpdateMap.forEach((planet, locId) => {
      if (planetsToUpdateMap.has(locId)) {
        planetVoyageMap.set(locId, []);
      }
    });

    for (const voyage of allVoyages) {
      const voyagesForToPlanet = planetVoyageMap.get(voyage.toPlanet);
      if (voyagesForToPlanet) {
        voyagesForToPlanet.push(voyage);
        planetVoyageMap.set(voyage.toPlanet, voyagesForToPlanet);
      }
    }

    const planetsToUpdate = planetsToUpdateMap.values();

    for (let i = 0; i < planetIds.length; i++) {
      const planet = planetsToUpdate.next().value;

      const voyagesForPlanet = planetVoyageMap.get(planet.locationId);
      if (voyagesForPlanet) {
        this.entityStore.replacePlanetFromContractData(
          planet,
          voyagesForPlanet,
          artifactsOnPlanets[i].map((a) => a.id)
        );
      }
    }

    for (const artifacts of artifactsOnPlanets) {
      this.entityStore.replaceArtifactsFromContractData(artifacts);
    }
  }

  private async hardRefreshArtifact(artifactId: ArtifactId): Promise<void> {
    const artifact = await this.contractsAPI.getArtifactById(artifactId);
    if (!artifact) return;
    this.entityStore.replaceArtifactFromContractData(artifact);
  }

  private async refreshMyGPTCredits(): Promise<void> {
    if (this.account) {
      this.myGPTCredits = await this.contractsAPI.getGPTCreditBalance(this.account);
      this.myGPTCredits$.publish(this.myGPTCredits);
    }
  }

  private onTxIntentFail(txIntent: TxIntent, e: Error): void {
    const notifManager = NotificationManager.getInstance();
    notifManager.unsubmittedTxFail(txIntent, e);

    this.terminal.current?.println(
      `[TX ERROR]: ${e.message.slice(0, 10000)}`,
      TerminalTextStyle.Red
    );
    this.entityStore.clearUnconfirmedTxIntent(txIntent);
  }

  public setUIDataItem(key: UIDataKey, value: number | boolean): void {
    this.uiStateStorageManager.setUIDataItem(key, value);
  }

  public getUIDataItem(key: UIDataKey): number | boolean {
    return this.uiStateStorageManager.getUIDataItem(key);
  }

  public getGptCreditPriceEmitter(): Monomitter<number> {
    return this.gptCreditPriceEtherEmitter$;
  }

  public getGptCreditBalanceEmitter(): Monomitter<number> {
    return this.myGPTCredits$;
  }

  /**
   * Gets the address of the player logged into this game manager.
   */
  public getAccount(): EthAddress | undefined {
    return this.account;
  }

  /**
   * Gets the address of the `DarkForestCore` contract, which is essentially
   * the 'backend' of the game.
   */
  public getContractAddress(): EthAddress {
    return this.contractsAPI.getContractAddress();
  }

  /**
   * Gets the twitter handle of the given ethereum account which is associated
   * with Dark Forest.
   */
  public getTwitter(address: EthAddress | undefined): string | undefined {
    let myAddress;
    if (!address) myAddress = this.getAccount();
    else myAddress = address;

    if (!myAddress) {
      return undefined;
    }
    const twitter = this.players.get(myAddress)?.twitter;
    return twitter;
  }

  /**
   * The game ends at a particular time in the future - get this time measured
   * in seconds from the epoch.
   */
  public getEndTimeSeconds(): number {
    return this.endTimeSeconds;
  }

  /**
   * Gets the rarity of planets in the universe
   */
  public getPlanetRarity(): number {
    return this.contractConstants.PLANET_RARITY;
  }

  /**
   * returns timestamp (seconds) that planet will reach percent% of energycap
   * time may be in the past
   */
  public getEnergyCurveAtPercent(planet: Planet, percent: number): number {
    return this.entityStore.getEnergyCurveAtPercent(planet, percent);
  }

  /**
   * returns timestamp (seconds) that planet will reach percent% of silcap if
   * doesn't produce silver, returns undefined if already over percent% of silcap,
   */
  public getSilverCurveAtPercent(planet: Planet, percent: number): number | undefined {
    return this.entityStore.getSilverCurveAtPercent(planet, percent);
  }

  /**
   * Returns the upgrade that would be applied to a planet given a particular
   * upgrade branch (defense, range, speed) and level of upgrade.
   */
  public getUpgrade(branch: number, level: number): Upgrade {
    return this.contractConstants.upgrades[branch][level];
  }

  /**
   * Gets a list of all the players in the game (not just the ones you've
   * encounterd)
   */
  public getAllPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  /**
   * Gets all the map chunks that this client is aware of. Chunks may have come from
   * mining, or from importing map data.
   */
  public getExploredChunks(): Iterable<ExploredChunkData> {
    return this.persistentChunkStore.allChunks();
  }

  /**
   * Gets the ids of all the planets that are both within the given bounding box (defined by its bottom
   * left coordinate, width, and height) in the world and of a level that was passed in via the
   * `planetLevels` parameter.
   */
  public getPlanetsInWorldRectangle(
    worldX: number,
    worldY: number,
    worldWidth: number,
    worldHeight: number,
    levels: number[],
    planetLevelToRadii: Map<number, Radii>,
    updateIfStale = true
  ): LocatablePlanet[] {
    return this.entityStore.getPlanetsInWorldRectangle(
      worldX,
      worldY,
      worldWidth,
      worldHeight,
      levels,
      planetLevelToRadii,
      updateIfStale
    );
  }

  /**
   * Gets the radius of the playable area of the universe.
   */
  public getWorldRadius(): number {
    return this.worldRadius;
  }

  /**
   * Gets the total amount of silver that lives on a planet that somebody owns.
   */
  public getWorldSilver(): number {
    return this.getAllOwnedPlanets().reduce(
      (totalSoFar: number, nextPlanet: Planet) => totalSoFar + nextPlanet.silver,
      0
    );
  }

  /**
   * Gets the total amount of energy that lives on a planet that somebody owns.
   */
  public getUniverseTotalEnergy(): number {
    return this.getAllOwnedPlanets().reduce(
      (totalSoFar: number, nextPlanet: Planet) => totalSoFar + nextPlanet.energy,
      0
    );
  }

  /**
   * Gets the total amount of silver that lives on planets that the given player owns.
   */
  public getSilverOfPlayer(player: EthAddress): number {
    return this.getAllOwnedPlanets()
      .filter((planet) => planet.owner === player)
      .reduce((totalSoFar: number, nextPlanet: Planet) => totalSoFar + nextPlanet.silver, 0);
  }

  /**
   * Gets the total amount of energy that lives on planets that the given player owns.
   */
  public getEnergyOfPlayer(player: EthAddress): number {
    return this.getAllOwnedPlanets()
      .filter((planet) => planet.owner === player)
      .reduce((totalSoFar: number, nextPlanet: Planet) => totalSoFar + nextPlanet.energy, 0);
  }

  public getWithdrawnSilverOfPlayer(addr: EthAddress): number {
    const player = this.players.get(addr);
    if (!player) return 0;
    return player.withdrawnSilver;
  }

  private initMiningManager(homeCoords: WorldCoords): void {
    if (this.minerManager) return;

    const myPattern: MiningPattern = new SpiralPattern(homeCoords, MIN_CHUNK_SIZE);

    this.minerManager = MinerManager.create(
      this.persistentChunkStore,
      myPattern,
      this.worldRadius,
      this.planetRarity,
      this.hashConfig,
      this.useMockHash
    );

    this.minerManager.on(
      MinerManagerEvent.DiscoveredNewChunk,
      (chunk: ExploredChunkData, miningTimeMillis: number) => {
        this.addNewChunk(chunk);
        this.hashRate = chunk.chunkFootprint.sideLength ** 2 / (miningTimeMillis / 1000);
        this.emit(GameManagerEvent.DiscoveredNewChunk, chunk);
      }
    );

    this.minerManager.startExplore();
  }

  /**
   * Sets the mining pattern of the miner. This kills the old miner and starts this one.
   */
  setMiningPattern(pattern: MiningPattern): void {
    if (this.minerManager) {
      this.minerManager.setMiningPattern(pattern);
    }
  }

  /**
   * Gets the mining pattern that the miner is currently using.
   */
  getMiningPattern(): MiningPattern | undefined {
    if (this.minerManager) return this.minerManager.getMiningPattern();
    else return undefined;
  }

  /**
   * Set the amount of cores to mine the universe with. More cores equals faster!
   */
  setMinerCores(nCores: number): void {
    this.minerManager?.setCores(nCores);

    this.terminal.current?.println(`Now mining on ${nCores} core(s).`);
  }

  /**
   * Whether or not the miner is currently exploring space.
   */
  isMining(): boolean {
    return this.minerManager?.isMining() || false;
  }

  /**
   * Changes the amount of move snark proofs that are cached.
   */
  setSnarkCacheSize(size: number): void {
    this.snarkHelper.setSnarkCacheSize(size);
  }

  /**
   * Gets the rectangle bounding the chunk that the miner is currently in the process
   * of hashing.
   */
  getCurrentlyExploringChunk(): Rectangle | undefined {
    if (this.minerManager) {
      return this.minerManager.getCurrentlyExploringChunk();
    }
    return undefined;
  }

  /**
   * Whether or not this client has successfully found and landed on a home planet.
   */
  hasJoinedGame(): boolean {
    return this.players.has(this.account as string);
  }

  /**
   * Returns info about the next time you can broadcast coordinates
   */
  getNextRevealCountdownInfo(): RevealCountdownInfo {
    if (!this.account) {
      throw new Error('no account set');
    }
    const myLastRevealTimestamp = this.players.get(this.account)?.lastRevealTimestamp;
    return {
      myLastRevealTimestamp: myLastRevealTimestamp || undefined,
      currentlyRevealing: !!this.entityStore.getUnconfirmedReveal(),
      revealCooldownTime: this.contractConstants.LOCATION_REVEAL_COOLDOWN,
    };
  }

  /**
   * gets both deposited artifacts that are on planets i own as well as artifacts i own
   */
  getMyArtifacts(): Artifact[] {
    if (!this.account) return [];
    const ownedByMe = this.entityStore.getArtifactsOwnedBy(this.account);
    const onPlanetsOwnedByMe = this.entityStore.getArtifactsOnPlanetsOwnedBy(this.account);
    return [...ownedByMe, ...onPlanetsOwnedByMe];
  }

  /**
   * Gets the planet that is located at the given coordinates. Returns undefined if not a valid
   * location or if no planet exists at location. If the planet needs to be updated (because
   * some time has passed since we last updated the planet), then updates that planet first.
   */
  getPlanetWithCoords(coords: WorldCoords): Planet | undefined {
    return this.entityStore.getPlanetWithCoords(coords);
  }

  /**
   * Gets the planet with the given hash. Returns undefined if the planet is neither in the contract
   * nor has been discovered locally. If the planet needs to be updated (because some time has
   * passed since we last updated the planet), then updates that planet first.
   */
  getPlanetWithId(planetId: LocationId | undefined): Planet | undefined {
    return planetId && this.entityStore.getPlanetWithId(planetId);
  }

  getStalePlanetWithId(planetId: LocationId): Planet | undefined {
    return this.entityStore.getPlanetWithId(planetId, false);
  }

  /**
   * Get the score of the currently logged-in account.
   */
  getMyScore(): number {
    if (!this.account) {
      return 0;
    }
    return this.players.get(this.account)?.withdrawnSilver || 0;
  }

  /**
   * Gets the artifact with the given id. Null if no artifact with id exists.
   */
  getArtifactWithId(artifactId: ArtifactId): Artifact | undefined {
    return this.entityStore.getArtifactById(artifactId);
  }

  /**
   * Gets the artifacts with the given ids, including ones we know exist but haven't been loaded,
   * represented by `undefined`.
   */
  getArtifactsWithIds(artifactIds: ArtifactId[]): Array<Artifact | undefined> {
    return artifactIds.map((id) => this.getArtifactWithId(id));
  }

  /**
   * Gets the level of the given planet. Returns undefined if the planet does not exist. Does
   * NOT update the planet if the planet is stale, which means this function is fast.
   */
  getPlanetLevel(planetId: LocationId): PlanetLevel | undefined {
    return this.entityStore.getPlanetLevel(planetId);
  }

  /**
   * Gets the location of the given planet. Returns undefined if the planet does not exist, or if
   * we do not know the location of this planet NOT update the planet if the planet is stale,
   * which means this function is fast.
   */
  getLocationOfPlanet(planetId: LocationId): WorldLocation | undefined {
    return this.entityStore.getLocationOfPlanet(planetId);
  }

  /**
   * Gets all voyages that have not completed.
   */
  getAllVoyages(): QueuedArrival[] {
    return this.entityStore.getAllVoyages();
  }

  /**
   * Gets all planets. This means all planets that are in the contract, and also all
   * planets that have been mined locally. Does not update planets if they are stale.
   * NOT PERFORMANT - for scripting only.
   */
  getAllPlanets(): Iterable<Planet> {
    return this.entityStore.getAllPlanets();
  }

  /**
   * Gets a list of planets that have an owner.
   */
  getAllOwnedPlanets(): Planet[] {
    return this.entityStore.getAllOwnedPlanets();
  }

  /**
   * Gets a list of the planets that the player logged into this `GameManager` owns.
   */
  getMyPlanets(): Planet[] {
    return this.getAllOwnedPlanets().filter((planet) => planet.owner === this.account);
  }

  /**
   * Gets a map of all location IDs whose coords have been publicly revealed
   */
  getRevealedLocations(): Map<LocationId, RevealedLocation> {
    return this.entityStore.getRevealedLocations();
  }

  /**
   * Each coordinate lives in a particular type of space, determined by a smooth random
   * function called 'perlin noise.
   */
  spaceTypeFromPerlin(perlin: number): SpaceType {
    return this.entityStore.spaceTypeFromPerlin(perlin);
  }

  /**
   * Gets the amount of hashes per second that the miner manager is calculating.
   */
  getHashesPerSec(): number {
    return this.hashRate;
  }

  /**
   * Signs the given twitter handle with the private key of the current user. Used to
   * verify that the person who owns the Dark Forest account was the one that attempted
   * to link a twitter to their account.
   */
  async getSignedTwitter(twitter: string): Promise<string> {
    return this.ethConnection.signMessage(twitter);
  }

  /**
   * Gets the private key of the burner wallet used by this account.
   */
  getPrivateKey(): string {
    return this.ethConnection.getPrivateKey();
  }

  /**
   * Gets the balance of the account
   */
  getMyBalance(): number {
    if (!this.account) return 0;
    return this.balance;
  }

  getMyBalanceEmitter(): Monomitter<number> {
    return this.myBalance$;
  }

  /**
   * Gets all moves that this client has queued to be uploaded to the contract, but
   * have not been successfully confirmed yet.
   */
  getUnconfirmedMoves(): UnconfirmedMove[] {
    return this.entityStore.getUnconfirmedMoves();
  }

  /**
   * Gets all upgrades that this client has queued to be uploaded to the contract, but
   * have not been successfully confirmed yet.
   */
  getUnconfirmedUpgrades(): UnconfirmedUpgrade[] {
    return this.entityStore.getUnconfirmedUpgrades();
  }

  getUnconfirmedWormholeActivations(): UnconfirmedActivateArtifact[] {
    return this.entityStore.getUnconfirmedWormholeActivations();
  }

  getWormholes(): Iterable<Wormhole> {
    return this.entityStore.getWormholes();
  }

  /**
   * Gets the location of your home planet.
   */
  getHomeCoords(): WorldCoords | undefined {
    if (!this.homeLocation) return undefined;
    return {
      x: this.homeLocation.coords.x,
      y: this.homeLocation.coords.y,
    };
  }

  /**
   * Gets the hash of the location of your home planet.
   */
  getHomeHash(): LocationId | undefined {
    return this.homeLocation?.hash;
  }

  /**
   * Gets the HASH CONFIG
   */
  getHashConfig(): HashConfig {
    return { ...this.hashConfig };
  }

  /**
   * Whether or not the given rectangle has been mined.
   */
  hasMinedChunk(chunkLocation: Rectangle): boolean {
    return this.persistentChunkStore.hasMinedChunk(chunkLocation);
  }

  getChunk(chunkFootprint: Rectangle): ExploredChunkData | undefined {
    return this.persistentChunkStore.getChunkByFootprint(chunkFootprint);
  }

  getChunkStore(): PersistentChunkStore {
    return this.persistentChunkStore;
  }

  /**
   * The perlin value at each coordinate determines the space type. There are four space
   * types, which means there are four ranges on the number line that correspond to
   * each space type. This function returns the boundary values between each of these
   * four ranges: `PERLIN_THRESHOLD_1`, `PERLIN_THRESHOLD_2`, `PERLIN_THRESHOLD_3`.
   */
  getPerlinThresholds(): [number, number, number] {
    return [
      this.contractConstants.PERLIN_THRESHOLD_1,
      this.contractConstants.PERLIN_THRESHOLD_2,
      this.contractConstants.PERLIN_THRESHOLD_3,
    ];
  }

  /**
   * Starts the miner.
   */
  startExplore(): void {
    if (this.minerManager) {
      this.minerManager.startExplore();
    }
  }

  /**
   * Stops the miner.
   */
  stopExplore(): void {
    if (this.minerManager) {
      this.hashRate = 0;
      this.minerManager.stopExplore();
    }
  }

  private setRadius(worldRadius: number) {
    this.worldRadius = worldRadius;

    if (this.minerManager) {
      this.minerManager.setRadius(this.worldRadius);
    }
  }

  private async refreshTwitters(): Promise<void> {
    // get twitter handles
    const addressTwitters = await getAllTwitters();
    for (const key of Object.keys(addressTwitters)) {
      const addr = address(key);
      const player = this.players.get(addr);
      if (player) player.twitter = addressTwitters[addr];
    }
  }

  /**
   * Once you have posted the verificatoin tweet - complete the twitter-account-linking
   * process by telling the Dark Forest webserver to look at that tweet.
   */
  async verifyTwitter(twitter: string): Promise<boolean> {
    if (!this.account) return Promise.resolve(false);
    const success = await verifyTwitterHandle(twitter, this.account);
    await this.refreshTwitters();
    return success;
  }

  private checkGameHasEnded(): boolean {
    if (Date.now() / 1000 > this.endTimeSeconds) {
      this.terminal.current?.println('[ERROR] Game has ended.');
      return true;
    }
    return false;
  }

  /**
   * Gets the timestamp (ms) of the next time that we can broadcast the coordinates of a planet.
   */
  public getNextBroadcastAvailableTimestamp() {
    if (!this.account) {
      throw new Error('no account set');
    }
    const myLastRevealTimestamp = this.players.get(this.account)?.lastRevealTimestamp;

    if (!myLastRevealTimestamp) {
      return Date.now();
    }

    // both the variables in the next line are denominated in seconds
    return (myLastRevealTimestamp + this.contractConstants.LOCATION_REVEAL_COOLDOWN) * 1000;
  }

  /**
   * Reveals a planet's location on-chain.
   */
  public revealLocation(planetId: LocationId): GameManager {
    if (this.checkGameHasEnded()) return this;

    if (!this.account) {
      throw new Error('no account set');
    }

    const planet = this.entityStore.getPlanetWithId(planetId);

    if (!planet) {
      throw new Error("you can't reveal a planet you haven't discovered");
    }

    if (!isLocatable(planet)) {
      throw new Error("you can't reveal a planet whose coordinates you don't know");
    }

    if (planet.coordsRevealed) {
      throw new Error("this planet's location is already revealed");
    }

    if (planet.unconfirmedReveal) {
      throw new Error("you're already revealing this planet's location");
    }

    if (!!this.entityStore.getUnconfirmedReveal()) {
      throw new Error("you're already broadcasting coordinates");
    }
    const myLastRevealTimestamp = this.players.get(this.account)?.lastRevealTimestamp;
    if (myLastRevealTimestamp && Date.now() < this.getNextBroadcastAvailableTimestamp()) {
      throw new Error('still on cooldown for broadcasting');
    }

    // this is shitty. used for the popup window
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-revealLocationId`, planetId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedReveal = {
      actionId,
      type: EthTxType.REVEAL_LOCATION,
      locationId: planetId,
      location: planet.location,
    };

    this.handleTxIntent(txIntent);

    this.snarkHelper
      .getRevealArgs(planet.location.coords.x, planet.location.coords.y)
      .then((snarkArgs) => {
        this.terminal.current?.println(
          'REVEAL: calculated SNARK with args:',
          TerminalTextStyle.Sub
        );
        this.terminal.current?.println(
          JSON.stringify(hexifyBigIntNestedArray(snarkArgs.slice(0, 3))),
          TerminalTextStyle.Sub
        );
        this.terminal.current?.newline();

        return this.contractsAPI.reveal(snarkArgs, txIntent);
      })
      .catch((err) => {
        this.onTxIntentFail(txIntent, err);
      });

    return this;
  }

  /**
   * Attempts to join the game. Should not be called once you've already joined.
   */
  joinGame(beforeRetry: (e: Error) => Promise<boolean>): GameManager {
    if (this.checkGameHasEnded()) return this;
    let actionId: string;
    let txIntent: UnconfirmedInit;
    this.getRandomHomePlanetCoords()
      .then(async (loc) => {
        const {
          coords: { x, y },
          hash: h,
        } = loc;
        this.homeLocation = loc;
        await this.persistentChunkStore.addHomeLocation(loc);
        actionId = getRandomActionId();
        txIntent = {
          actionId,
          type: EthTxType.INIT,
          locationId: h,
          location: loc,
        };
        this.handleTxIntent(txIntent as TxIntent);
        const callArgs = await this.snarkHelper.getInitArgs(x, y, this.worldRadius);
        this.initMiningManager(loc.coords); // get an early start

        // if player initialization causes an error, give the caller an opportunity
        // to resolve that error. if the asynchronous `beforeRetry` function returns
        // true, retry initializing the player. if it returns false, or if the
        // `beforeRetry` is undefined, then don't retry and throw an exception.
        while (true) {
          try {
            this.terminal.current?.println(
              'INIT: calculated SNARK with args:',
              TerminalTextStyle.Sub
            );
            this.terminal.current?.println(
              JSON.stringify(hexifyBigIntNestedArray(callArgs.slice(0, 3))),
              TerminalTextStyle.Sub
            );
            this.terminal.current?.newline();
            await this.contractsAPI.initializePlayer(callArgs, txIntent);
            break;
          } catch (e) {
            if (beforeRetry) {
              if (await beforeRetry(e)) {
                continue;
              }
            } else {
              throw e;
            }
          }
        }
      })
      .catch((err) => {
        this.onTxIntentFail(txIntent, err);
        this.emit(GameManagerEvent.InitializedPlayerError, err);
      });

    return this;
  }

  // this is slow, do not call in i.e. render/draw loop
  /**
   *
   * computes the WorldLocation object corresponding to a set of coordinates
   * very slow since it actually calculates the hash; do not use in render loop
   */
  private locationFromCoords(coords: WorldCoords): WorldLocation {
    return {
      coords,
      hash: locationIdFromBigInt(this.planetHashMimc(coords.x, coords.y)),
      perlin: this.spaceTypePerlin(coords, true),
      biomebase: this.biomebasePerlin(coords, true),
    };
  }

  /**
   * Initializes a new player's game to start at the given home planet. Must have already
   * initialized the player on the contract.
   */
  async addAccount(coords: WorldCoords): Promise<boolean> {
    const loc: WorldLocation = this.locationFromCoords(coords);
    await this.persistentChunkStore.addHomeLocation(loc);
    this.initMiningManager(coords);
    this.homeLocation = loc;
    return true;
  }

  private async getRandomHomePlanetCoords(): Promise<WorldLocation> {
    return new Promise<WorldLocation>((resolve) => {
      const initPerlinMin = this.contractConstants.INIT_PERLIN_MIN;
      const initPerlinMax = this.contractConstants.INIT_PERLIN_MAX;
      let minedChunksCount = 0;

      let x: number;
      let y: number;
      let d: number;
      let p: number;

      const isProd = process.env.NODE_ENV === 'production';
      let spawnInnerRadius = 0;
      if (isProd) {
        // there is always a fixed area for players to spawn in, equal to the
        // area of a 32 radius disc
        spawnInnerRadius = Math.sqrt(Math.max(this.worldRadius ** 2 - 32000 ** 2, 0));
      }

      do {
        // sample from square
        x = Math.random() * this.worldRadius * 2 - this.worldRadius;
        y = Math.random() * this.worldRadius * 2 - this.worldRadius;
        d = Math.sqrt(x ** 2 + y ** 2);
        p = this.spaceTypePerlin({ x, y }, false);
      } while (
        p >= initPerlinMax || // keep searching if above or equal to the max
        p < initPerlinMin || // keep searching if below the minimum
        d >= this.worldRadius || // can't be out of bound
        d <= spawnInnerRadius // can't be inside spawn percentage ring
      );

      // when setting up a new account in development mode, you can tell
      // the game where to start searching for planets using this query
      // string parameter. for example:
      //
      // ?searchCenter=2866,5627
      //

      const params = new URLSearchParams(window.location.search);

      if (params.has('searchCenter')) {
        const parts = params.get('searchCenter')?.split(',');

        if (parts) {
          x = parseInt(parts[0], 10);
          y = parseInt(parts[1], 10);
        }
      }

      const pattern: MiningPattern = new SpiralPattern({ x, y }, MIN_CHUNK_SIZE);
      const chunkStore = new HomePlanetMinerChunkStore(
        initPerlinMin,
        initPerlinMax,
        this.hashConfig
      );
      const homePlanetFinder = MinerManager.create(
        chunkStore,
        pattern,
        this.worldRadius,
        this.planetRarity,
        this.hashConfig,
        this.useMockHash
      );
      homePlanetFinder.on(MinerManagerEvent.DiscoveredNewChunk, (chunk: ExploredChunkData) => {
        chunkStore.addChunk(chunk);
        minedChunksCount++;
        if (minedChunksCount % 8 === 0) {
          this.terminal.current?.println(
            `Hashed ${minedChunksCount * MIN_CHUNK_SIZE ** 2} potential home planets...`
          );
        }
        for (const planetLoc of chunk.planetLocations) {
          const planetPerlin = planetLoc.perlin;
          const planetX = planetLoc.coords.x;
          const planetY = planetLoc.coords.y;
          const planetLevel = this.entityStore.planetLevelFromHexPerlin(
            planetLoc.hash,
            planetLoc.perlin
          );
          const planetType = this.entityStore.planetTypeFromHexPerlin(
            planetLoc.hash,
            planetLoc.perlin
          );
          const planet = this.getPlanetWithId(planetLoc.hash);
          if (
            planetPerlin < initPerlinMax &&
            planetPerlin >= initPerlinMin &&
            planetX ** 2 + planetY ** 2 < this.worldRadius ** 2 &&
            planetLevel === PlanetLevel.MIN &&
            planetType === PlanetType.PLANET &&
            (!planet || !planet.isInContract) // init will fail if planet has been initialized in contract already
          ) {
            // valid home planet
            homePlanetFinder.stopExplore();
            homePlanetFinder.destroy();
            resolve(planetLoc);
            break;
          }
        }
      });
      homePlanetFinder.startExplore();
    });
  }

  public async prospectPlanet(planetId: LocationId, bypassChecks = false) {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;

      const planet = this.entityStore.getPlanetWithId(planetId);

      if (!planet) {
        throw new Error("you can't prospect a planet you haven't discovered");
      }

      if (planet.owner !== this.getAccount()) {
        throw new Error("you can't prospect a planet you don't own");
      }

      if (!isLocatable(planet)) {
        throw new Error("you don't know this planet's location");
      }

      if (planet.prospectedBlockNumber !== undefined) {
        throw new Error('someone already prospected this planet');
      }

      if (planet.unconfirmedFindArtifact) {
        throw new Error("you're already looking bro...");
      }

      if (planet.planetType !== PlanetType.RUINS) {
        throw new Error("this planet doesn't have an artifact on it.");
      }

      if (planet.energy < planet.energyCap * 0.95) {
        throw new Error('you can only prospect planets that are 95% to the energy cap');
      }
    }

    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-prospectPlanet`, planetId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedProspectPlanet = {
      actionId,
      type: EthTxType.PROSPECT_PLANET,
      planetId: planetId,
    };

    this.handleTxIntent(txIntent);

    await this.contractsAPI.prospectPlanet(planetId, actionId).catch((err) => {
      this.onTxIntentFail(txIntent, err);
    });
  }

  /**
   * Calls the contract to find an artifact on the given planet.
   */
  public findArtifact(planetId: LocationId, bypassChecks = false): GameManager {
    const planet = this.entityStore.getPlanetWithId(planetId);

    if (!planet) {
      throw new Error("you can't find artifacts on a planet you haven't discovered");
    }

    if (!isLocatable(planet)) {
      throw new Error("you don't know the biome of this planet");
    }

    if (!bypassChecks) {
      if (this.checkGameHasEnded()) {
        throw new Error('game has ended');
      }

      if (planet.owner !== this.getAccount()) {
        throw new Error("you can't find artifacts on planets you don't own");
      }

      if (planet.hasTriedFindingArtifact) {
        throw new Error('someone already tried finding an artifact on this planet');
      }

      if (planet.unconfirmedFindArtifact) {
        throw new Error("you're already looking bro...");
      }

      if (planet.planetType !== PlanetType.RUINS) {
        throw new Error("this planet doesn't have an artifact on it.");
      }
    }

    // this is shitty. used for the popup window
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-findArtifactOnPlanet`, planetId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedFindArtifact = {
      actionId,
      type: EthTxType.FIND_ARTIFACT,
      planetId,
    };

    this.handleTxIntent(txIntent);

    this.snarkHelper
      .getFindArtifactArgs(planet.location.coords.x, planet.location.coords.y)
      .then((snarkArgs) => {
        this.terminal.current?.println(
          'ARTIFACT: calculated SNARK with args:',
          TerminalTextStyle.Sub
        );
        this.terminal.current?.println(
          JSON.stringify(hexifyBigIntNestedArray(snarkArgs.slice(0, 3))),
          TerminalTextStyle.Sub
        );
        this.terminal.current?.newline();

        return this.contractsAPI.findArtifact(planet.location, snarkArgs, actionId);
      })
      .catch((err) => {
        this.onTxIntentFail(txIntent, err);
      });

    return this;
  }

  getContractConstants(): ContractConstants {
    return this.contractConstants;
  }

  /**
   * Submits a transaction to the blockchain to deposit an artifact on a given planet.
   * You must own the planet and you must own the artifact directly (can't be locked in contract)
   */
  depositArtifact(
    locationId: LocationId,
    artifactId: ArtifactId,
    bypassChecks = true
  ): GameManager {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;
    }
    // this is shitty. used for the popup window
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-depositPlanet`, locationId);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-depositArtifact`, artifactId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedDepositArtifact = {
      actionId,
      type: EthTxType.DEPOSIT_ARTIFACT,
      locationId,
      artifactId,
    };
    this.handleTxIntent(txIntent);

    this.terminal.current?.println(
      'DEPOSIT_ARTIFACT: sending deposit to blockchain',
      TerminalTextStyle.Sub
    );
    this.terminal.current?.newline();
    this.contractsAPI.depositArtifact(txIntent).catch((e) => this.onTxIntentFail(txIntent, e));
    return this;
  }

  /**
   * Withdraws the artifact that is locked up on the given planet.
   */
  withdrawArtifact(
    locationId: LocationId,
    artifactId: ArtifactId,
    bypassChecks = true
  ): GameManager {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;

      const planet = this.entityStore.getPlanetWithId(locationId);
      if (!planet) {
        console.error('tried to withdraw from unknown planet');
        return this;
      }
      if (!artifactId) {
        console.error('must supply an artifact id');
        return this;
      }
    }

    // this is shitty. used for the popup window
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-withdrawPlanet`, locationId);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-withdrawArtifact`, artifactId);

    if (Date.now() / 1000 > this.endTimeSeconds) {
      this.terminal.current?.println('[ERROR] Game has ended.');
      return this;
    }

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedWithdrawArtifact = {
      actionId,
      type: EthTxType.WITHDRAW_ARTIFACT,
      locationId,
      artifactId,
    };

    this.handleTxIntent(txIntent);

    this.terminal.current?.println(
      'WITHDRAW_ARTIFACT: sending withdrawal to blockchain',
      TerminalTextStyle.Sub
    );
    this.terminal.current?.newline();

    this.contractsAPI.withdrawArtifact(txIntent).catch((e) => this.onTxIntentFail(txIntent, e));
    return this;
  }

  activateArtifact(
    locationId: LocationId,
    artifactId: ArtifactId,
    wormholeTo: LocationId | undefined,
    bypassChecks = false
  ) {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;

      const planet = this.entityStore.getPlanetWithId(locationId);

      if (!planet) {
        throw new Error('tried to activate on an unknown planet');
      }
      if (!artifactId) {
        throw new Error('must supply an artifact id');
      }
    }

    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-activatePlanet`, locationId);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-activateArtifact`, artifactId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedActivateArtifact = {
      actionId,
      type: EthTxType.ACTIVATE_ARTIFACT,
      locationId,
      artifactId,
      wormholeTo,
    };

    this.handleTxIntent(txIntent);
    this.contractsAPI.activateArtifact(txIntent).catch((e) => this.onTxIntentFail(txIntent, e));
    return this;
  }

  deactivateArtifact(locationId: LocationId, artifactId: ArtifactId, bypassChecks = false) {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;

      const planet = this.entityStore.getPlanetWithId(locationId);
      if (!planet) {
        throw new Error('tried to deactivate on an unknown planet');
      }
    }

    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-deactivatePlanet`, locationId);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-deactivateArtifact`, artifactId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedDeactivateArtifact = {
      actionId,
      type: EthTxType.DEACTIVATE_ARTIFACT,
      locationId,
      artifactId,
    };

    this.handleTxIntent(txIntent);
    this.contractsAPI.deactivateArtifact(txIntent).catch((e) => this.onTxIntentFail(txIntent, e));
  }

  withdrawSilver(locationId: LocationId, amount: number, bypassChecks = false) {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;
      if (!this.account) return this;

      const planet = this.entityStore.getPlanetWithId(locationId);
      if (!planet) {
        throw new Error('tried to withdraw silver from an unknown planet');
      }
      if (planet.planetType !== PlanetType.TRADING_POST) {
        throw new Error('can only withdraw silver from spacetime rips');
      }
      if (planet.owner !== this.account) {
        throw new Error('can only withdraw silver from a planet you own');
      }
      if (planet.unconfirmedWithdrawSilver) {
        throw new Error('a withdraw silver action is already in progress for this planet');
      }
      if (amount > planet.silver) {
        throw new Error('not enough silver to withdraw!');
      }
      if (amount === 0) {
        throw new Error('must withdraw more than 0 silver!');
      }
      if (planet.destroyed) {
        throw new Error("can't withdraw silver from a destroyed planet");
      }
    }

    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-withdrawSilverPlanet`, locationId);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedWithdrawSilver = {
      actionId,
      type: EthTxType.WITHDRAW_SILVER,
      locationId,
      amount,
    };

    this.handleTxIntent(txIntent);
    this.contractsAPI.withdrawSilver(txIntent).catch((e) => this.onTxIntentFail(txIntent, e));
  }

  /**
   * Submits a transaction to the blockchain to move the given amount of resources from
   * the given planet to the given planet.
   */
  move(
    from: LocationId,
    to: LocationId,
    forces: number,
    silver: number,
    artifactMoved?: ArtifactId,
    bypassChecks = false
  ): GameManager {
    if (this.checkGameHasEnded()) return this;
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-fromPlanet`, from);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-toPlanet`, to);

    if (!bypassChecks && Date.now() / 1000 > this.endTimeSeconds) {
      this.terminal.current?.println('[ERROR] Game has ended.');
      return this;
    }

    const oldLocation = this.entityStore.getLocationOfPlanet(from);
    const newLocation = this.entityStore.getLocationOfPlanet(to);
    if (!oldLocation) {
      console.error('tried to move from planet that does not exist');
      return this;
    }
    if (!newLocation) {
      console.error('tried to move from planet that does not exist');
      return this;
    }

    const oldX = oldLocation.coords.x;
    const oldY = oldLocation.coords.y;
    const newX = newLocation.coords.x;
    const newY = newLocation.coords.y;
    const xDiff = newX - oldX;
    const yDiff = newY - oldY;

    const distMax = Math.ceil(Math.sqrt(xDiff ** 2 + yDiff ** 2));

    const shipsMoved = forces;
    const silverMoved = silver;

    if (newX ** 2 + newY ** 2 >= this.worldRadius ** 2) {
      throw new Error('attempted to move out of bounds');
    }

    const oldPlanet = this.entityStore.getPlanetWithLocation(oldLocation);

    if ((!bypassChecks && !this.account) || !oldPlanet || oldPlanet.owner !== this.account) {
      throw new Error('attempted to move from a planet not owned by player');
    }
    const actionId = getRandomActionId();
    const txIntent: UnconfirmedMove = {
      actionId,
      type: EthTxType.MOVE,
      from: oldLocation.hash,
      to: newLocation.hash,
      forces: shipsMoved,
      silver: silverMoved,
    };

    if (artifactMoved) {
      const artifact = this.entityStore.getArtifactById(artifactMoved);
      if (!bypassChecks) {
        if (!artifact) {
          throw new Error("couldn't find this artifact");
        }
        if (isActivated(artifact)) {
          throw new Error("can't move an activated artifact");
        }
        if (!oldPlanet.heldArtifactIds.includes(artifactMoved)) {
          throw new Error("that artifact isn't on this planet!");
        }
      }
      txIntent.artifact = artifactMoved;
    }

    this.handleTxIntent(txIntent);

    this.snarkHelper
      .getMoveArgs(oldX, oldY, newX, newY, this.worldRadius, distMax)
      .then((callArgs) => {
        this.terminal.current?.println('MOVE: calculated SNARK with args:', TerminalTextStyle.Sub);
        this.terminal.current?.println(
          JSON.stringify(hexifyBigIntNestedArray(callArgs)),
          TerminalTextStyle.Sub
        );
        this.terminal.current?.newline();

        return this.contractsAPI.move(actionId, callArgs, shipsMoved, silverMoved, artifactMoved);
      })
      .catch((err) => {
        this.onTxIntentFail(txIntent, err);
      });
    return this;
  }

  /**
   * Submits a transaction to the blockchain to upgrade the given planet with the given
   * upgrade branch. You must own the planet, and have enough silver on it to complete
   * the upgrade.
   */
  upgrade(planetId: LocationId, branch: number, _bypassChecks = false): GameManager {
    if (this.checkGameHasEnded()) return this;
    // this is shitty
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-upPlanet`, planetId);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-branch`, branch.toString());

    const upgradeArgs: UpgradeArgs = [locationIdToDecStr(planetId), branch.toString()];
    const actionId = getRandomActionId();
    const txIntent = {
      actionId,
      type: EthTxType.UPGRADE,
      locationId: planetId,
      upgradeBranch: branch,
    };
    this.handleTxIntent(txIntent);

    this.terminal.current?.println('UPGRADE: sending upgrade to blockchain', TerminalTextStyle.Sub);
    this.terminal.current?.newline();
    this.contractsAPI
      .upgradePlanet(upgradeArgs, actionId)
      .catch((e) => this.onTxIntentFail(txIntent, e));

    return this;
  }

  /**
   * Submits a transaction to the blockchain to buy a hat for the given planet. You
   * must own the planet. Warning costs real xdai. Hats are permanently locked to a
   * planet. They are purely cosmetic and a great way to BM your opponents or just
   * look your best. Just like in the real world, more money means more hat.
   */
  buyHat(planetId: LocationId, _bypassChecks = false): GameManager {
    if (this.checkGameHasEnded()) return this;

    const planetLoc = this.entityStore.getLocationOfPlanet(planetId);
    if (!planetLoc) {
      console.error('planet not found');
      this.terminal.current?.println('[TX ERROR] Planet not found');
      return this;
    }
    const planet = this.entityStore.getPlanetWithLocation(planetLoc);
    if (!planet) {
      console.error('planet not found');
      this.terminal.current?.println('[TX ERROR] Planet not found');
      return this;
    }

    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-hatPlanet`, planetId);
    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-hatLevel`,
      (planet.hatLevel + 1).toString()
    );

    const actionId = getRandomActionId();
    const txIntent = {
      actionId,
      type: EthTxType.BUY_HAT,
      locationId: planetId,
    };
    this.handleTxIntent(txIntent);

    this.terminal.current?.println('BUY HAT: sending request to blockchain', TerminalTextStyle.Sub);
    this.terminal.current?.newline();

    this.contractsAPI.buyHat(locationIdToDecStr(planetId), planet.hatLevel, actionId).catch((e) => {
      this.onTxIntentFail(txIntent, e);
    });
    return this;
  }

  transferOwnership(planetId: LocationId, newOwner: EthAddress, bypassChecks = false): GameManager {
    if (!bypassChecks) {
      if (this.checkGameHasEnded()) return this;
      const planetLoc = this.entityStore.getLocationOfPlanet(planetId);
      if (!planetLoc) {
        console.error('planet not found');
        this.terminal.current?.println('[TX ERROR] Planet not found');
        return this;
      }
      const planet = this.entityStore.getPlanetWithLocation(planetLoc);
      if (!planet) {
        console.error('planet not found');
        this.terminal.current?.println('[TX ERROR] Planet not found');
        return this;
      }
    }

    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-transferPlanet`, planetId);
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-transferOwner`, newOwner);

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedPlanetTransfer = {
      actionId,
      type: EthTxType.PLANET_TRANSFER,
      planetId,
      newOwner,
    };
    this.handleTxIntent(txIntent);

    this.contractsAPI
      .transferOwnership(planetId, newOwner, actionId)
      .catch((e) => this.onTxIntentFail(txIntent, e));
    return this;
  }

  buyGPTCredits(amount: number) {
    if (this.checkGameHasEnded()) return this;

    const cost = this.gptCreditPriceEther * amount;

    if (cost > this.balance) {
      throw new Error('not enough balance to buy credits!');
    }
    if (this.entityStore.getUnconfirmedBuyGPTCredits()) {
      throw new Error('already processing GPT credit purchase');
    }

    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-buyGPTCreditAmount`,
      amount.toString()
    );
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-buyGPTCreditCost`, cost.toString());

    const actionId = getRandomActionId();
    const txIntent: UnconfirmedBuyGPTCredits = {
      actionId,
      type: EthTxType.BUY_GPT_CREDITS,
      amount,
    };
    this.handleTxIntent(txIntent);

    this.contractsAPI
      .buyGPTCredits(amount, actionId)
      .catch((e) => this.onTxIntentFail(txIntent, e));
    return this;
  }

  private handleTxIntent(txIntent: TxIntent) {
    this.entityStore.onTxIntent(txIntent);
  }

  public getIsBuyingCreditsEmitter() {
    return this.entityStore.getIsBuyingCreditsEmitter();
  }

  /**
   * Gets the GPT conversation with an artifact; undefined if there is none so far
   */
  async getConversation(artifactId: ArtifactId): Promise<Conversation | undefined> {
    return getConversation(artifactId);
  }

  /**
   * Starts a GPT conversation with an artifact
   */
  async startConversation(artifactId: ArtifactId): Promise<Conversation> {
    const artifact = this.entityStore.getArtifactById(artifactId);

    if (!artifact) {
      throw new Error('artifact with this ID does not exist');
    }
    if (this.entityStore.getArtifactController(artifactId) !== this.account) {
      throw new Error("can't talk with artifact you don't own");
    }
    if (!this.account) {
      throw new Error('must be logged in');
    }
    if (this.myGPTCredits === 0) {
      throw new Error("You don't have any GPT credits! You can purchase some below.");
    }

    const timestamp = Date.now();
    const stringToSign = stringify({
      timestamp,
      artifactId,
    });
    const signature = await this.ethConnection.signMessage(stringToSign);
    const conversation = await startConversation(timestamp, this.account, signature, artifactId);

    await this.refreshMyGPTCredits();

    return conversation;
  }

  /**
   * Sends a message to an artifact you are having a GPT conversation with
   */
  async stepConversation(artifactId: ArtifactId, message: string): Promise<Conversation> {
    const artifact = this.entityStore.getArtifactById(artifactId);

    if (!artifact) {
      throw new Error('artifact with this ID does not exist');
    }
    if (this.entityStore.getArtifactController(artifactId) !== this.account) {
      throw new Error("can't talk with artifact you don't own");
    }
    if (!this.account) {
      throw new Error('must be logged in');
    }
    if (this.myGPTCredits === 0) {
      throw new Error("You don't have any GPT credits! You can purchase some below.");
    }

    const timestamp = Date.now();
    const stringToSign = stringify({
      timestamp,
      artifactId,
      message,
    });
    const signature = await this.ethConnection.signMessage(stringToSign);
    const conversation = await stepConversation(
      timestamp,
      this.account,
      signature,
      artifactId,
      message
    );
    if (!conversation) {
      throw new Error("you're probably being rate limited!");
    }

    await this.refreshMyGPTCredits();

    return conversation;
  }

  /**
   * Makes this game manager aware of a new chunk - which includes its location, size,
   * as well as all of the planets contained in that chunk. Causes the client to load
   * all of the information about those planets from the blockchain.
   */
  addNewChunk(chunk: ExploredChunkData): GameManager {
    this.persistentChunkStore.updateChunk(chunk, false);
    for (const planetLocation of chunk.planetLocations) {
      this.entityStore.addPlanetLocation(planetLocation);

      if (this.entityStore.isPlanetInContract(planetLocation.hash)) {
        this.hardRefreshPlanet(planetLocation.hash); // don't need to await, just start the process of hard refreshing
      }
    }
    return this;
  }

  /**
   * To add multiple chunks at once, use this function rather than `addNewChunk`, in order
   * to load all of the associated planet data in an efficient manner.
   */
  async bulkAddNewChunks(chunks: ExploredChunkData[]): Promise<void> {
    this.terminal.current?.println(
      'IMPORTING MAP: if you are importing a large map, this may take a while...'
    );
    const planetIdsToUpdate: LocationId[] = [];
    for (const chunk of chunks) {
      this.persistentChunkStore.updateChunk(chunk, false);
      for (const planetLocation of chunk.planetLocations) {
        this.entityStore.addPlanetLocation(planetLocation);

        if (this.entityStore.isPlanetInContract(planetLocation.hash)) {
          // Await this so we don't crash the game
          planetIdsToUpdate.push(planetLocation.hash);
        }
      }
    }
    this.terminal.current?.println(
      `downloading data for ${planetIdsToUpdate.length} planets...`,
      TerminalTextStyle.Sub
    );
    this.bulkHardRefreshPlanets(planetIdsToUpdate);
  }

  // utils - scripting only

  /**
   * Gets the maximuim distance that you can send your energy from the given planet,
   * using the given percentage of that planet's current silver.
   */
  getMaxMoveDist(planetId: LocationId, sendingPercent: number): number {
    const planet = this.getPlanetWithId(planetId);
    if (!planet) throw new Error('origin planet unknown');
    // log_2(sendingPercent / 5%)
    let ratio = Math.log(sendingPercent / 5) / Math.log(2);
    ratio = Math.max(ratio, 0);
    return ratio * planet.range;
  }

  /**
   * Gets the distance between two planets. Throws an exception if you don't
   * know the location of either planet.
   */
  getDist(fromId: LocationId, toId: LocationId): number {
    const fromLoc = this.entityStore.getLocationOfPlanet(fromId);
    if (!fromLoc) throw new Error('origin location unknown');
    const toLoc = this.entityStore.getLocationOfPlanet(toId);
    if (!toLoc) throw new Error('destination location unknown');

    return this.getDistCoords(fromLoc.coords, toLoc.coords);
  }

  /**
   * Gets the distance between two coordinates in space.
   */
  getDistCoords(fromCoords: WorldCoords, toCoords: WorldCoords) {
    return Math.sqrt((fromCoords.x - toCoords.x) ** 2 + (fromCoords.y - toCoords.y) ** 2);
  }

  /**
   * Gets all the planets that you can reach with at least 1 energy from
   * the given planet.
   */
  getPlanetsInRange(planetId: LocationId, sendingPercent: number): Planet[] {
    const loc = this.entityStore.getLocationOfPlanet(planetId);
    if (!loc) throw new Error('origin planet location unknown');

    const ret: Planet[] = [];
    const maxDist = this.getMaxMoveDist(planetId, sendingPercent);
    const planetsIt = this.entityStore.getAllPlanets();
    for (const toPlanet of planetsIt) {
      const toLoc = this.entityStore.getLocationOfPlanet(toPlanet.locationId);
      if (!toLoc) continue;

      const { x: fromX, y: fromY } = loc.coords;
      const { x: toX, y: toY } = toLoc.coords;
      if ((fromX - toX) ** 2 + (fromY - toY) ** 2 < maxDist ** 2) {
        ret.push(toPlanet);
      }
    }
    return ret;
  }

  /**
   * Gets the amount of energy needed in order for a voyage from the given to the given
   * planet to arrive with your desired amount of energy.
   */
  getEnergyNeededForMove(fromId: LocationId, toId: LocationId, arrivingEnergy: number): number {
    const from = this.getPlanetWithId(fromId);
    if (!from) throw new Error('origin planet unknown');
    const dist = this.getDist(fromId, toId);
    const rangeSteps = dist / from.range;

    const arrivingProp = arrivingEnergy / from.energyCap + 0.05;

    return arrivingProp * Math.pow(2, rangeSteps) * from.energyCap;
  }

  /**
   * Gets the amount of energy that would arrive if a voyage with the given parameters
   * was to occur. The toPlanet is optional, in case you want an estimate that doesn't include
   * wormhole speedups.
   */
  getEnergyArrivingForMove(
    fromId: LocationId,
    toId: LocationId | undefined,
    distance: number | undefined,
    sentEnergy: number
  ) {
    const from = this.getPlanetWithId(fromId);
    const to = this.getPlanetWithId(toId);

    if (!from) throw new Error(`unknown planet`);
    if (distance === undefined && toId === undefined)
      throw new Error(`you must provide either a target planet or a distance`);

    let dist = (toId && this.getDist(fromId, toId)) || (distance as number);

    if (to && toId) {
      const wormholeFactors = this.getWormholeFactors(from, to);
      if (wormholeFactors !== undefined) {
        if (to.owner === from.owner) {
          dist /= wormholeFactors.distanceFactor;
        } else {
          return 0;
        }
      }
    }

    const scale = (1 / 2) ** (dist / from.range);
    let ret = scale * sentEnergy - 0.05 * from.energyCap;
    if (ret < 0) ret = 0;

    return ret;
  }

  /**
   * Gets the active artifact on this planet, if one exists.
   */
  getActiveArtifact(planet: Planet): Artifact | undefined {
    const artifacts = this.getArtifactsWithIds(planet.heldArtifactIds);
    const active = artifacts.find((a) => a && isActivated(a));

    return active;
  }

  /**
   * If there's an active artifact on either of these planets which happens to be a wormhole which
   * is active and targetting the other planet, return the wormhole boost which is greater. Values
   * represent a multiplier.
   */
  getWormholeFactors(
    fromPlanet: Planet,
    toPlanet: Planet
  ): { distanceFactor: number; speedFactor: number } | undefined {
    const fromActiveArtifact = this.getActiveArtifact(fromPlanet);
    const toActiveArtifact = this.getActiveArtifact(toPlanet);

    let greaterRarity: ArtifactRarity | undefined;

    if (
      fromActiveArtifact?.artifactType === ArtifactType.Wormhole &&
      fromActiveArtifact.wormholeTo === toPlanet.locationId
    ) {
      greaterRarity = fromActiveArtifact.rarity;
    }

    if (
      toActiveArtifact?.artifactType === ArtifactType.Wormhole &&
      toActiveArtifact.wormholeTo === fromPlanet.locationId
    ) {
      if (greaterRarity === undefined) {
        greaterRarity = toActiveArtifact.rarity;
      } else {
        greaterRarity = Math.max(greaterRarity, toActiveArtifact.rarity);
      }
    }

    const rangeUpgradesPerRarity = [0, 2, 4, 6, 8, 10];
    const speedUpgradesPerRarity = [0, 10, 20, 30, 40, 50];

    if (!greaterRarity || greaterRarity <= ArtifactRarity.Unknown) {
      return undefined;
    }

    return {
      distanceFactor: rangeUpgradesPerRarity[greaterRarity],
      speedFactor: speedUpgradesPerRarity[greaterRarity],
    };
  }

  /**
   * Gets the amount of time, in seconds that a voyage between from the first to the
   * second planet would take.
   */
  getTimeForMove(fromId: LocationId, toId: LocationId): number {
    const from = this.getPlanetWithId(fromId);
    if (!from) throw new Error('origin planet unknown');
    const dist = this.getDist(fromId, toId);
    return dist / (from.speed / 100);
  }

  /**
   * Gets the temperature of a given location.
   */
  getTemperature(coords: WorldCoords): number {
    const p = this.spaceTypePerlin(coords, false);
    return (16 - p) * 16;
  }

  /**
   * Load the serialized versions of all the plugins that this player has.
   */
  public async loadPlugins(): Promise<SerializedPlugin[]> {
    return this.persistentChunkStore.loadPlugins();
  }

  /**
   * Overwrites all the saved plugins to equal the given array of plugins.
   */
  public async savePlugins(savedPlugins: SerializedPlugin[]): Promise<void> {
    await this.persistentChunkStore.savePlugins(savedPlugins);
  }

  /**
   * Whether or not the given planet is capable of minting an artifact.
   */
  public isPlanetMineable(p: Planet): boolean {
    return p.planetType === PlanetType.RUINS;
  }

  /**
   * Returns constructors of classes that may be useful for developing plugins.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getConstructors() {
    return {
      MinerManager,
      SpiralPattern,
      SwissCheesePattern,
    };
  }

  /**
   * Gets the perlin value at the given location in the world. SpaceType is based
   * on this value.
   */
  public spaceTypePerlin(coords: WorldCoords, floor: boolean): number {
    return perlin(coords, {
      key: this.hashConfig.spaceTypeKey,
      scale: this.hashConfig.perlinLengthScale,
      mirrorX: this.hashConfig.perlinMirrorX,
      mirrorY: this.hashConfig.perlinMirrorY,
      floor,
    });
  }

  /**
   * Gets the biome perlin valie at the given location in the world.
   */
  public biomebasePerlin(coords: WorldCoords, floor: boolean): number {
    return perlin(coords, {
      key: this.hashConfig.biomebaseKey,
      scale: this.hashConfig.perlinLengthScale,
      mirrorX: this.hashConfig.perlinMirrorX,
      mirrorY: this.hashConfig.perlinMirrorY,
      floor,
    });
  }

  /**
   * Helpful functions for getting the names, descriptions, and colors of in-game entities.
   */
  public getProcgenUtils() {
    return ProcgenUtils;
  }

  /**
   * Helpful for listening to user input events.
   */
  public getUIEventEmitter() {
    return UIEmitter.getInstance();
  }

  public getNotificationsManager() {
    return NotificationManager.getInstance();
  }

  /** Return a reference to the planet map */
  public getPlanetMap(): Map<LocationId, Planet> {
    return this.entityStore.getPlanetMap();
  }

  /** Return a reference to the artifact map */
  public getArtifactMap(): Map<ArtifactId, Artifact> {
    return this.entityStore.getArtifactMap();
  }

  /** Return a reference to the map of my planets */
  public getMyPlanetMap(): Map<LocationId, Planet> {
    return this.entityStore.getMyPlanetMap();
  }

  /** Return a reference to the map of my artifacts */
  public getMyArtifactMap(): Map<ArtifactId, Artifact> {
    return this.entityStore.getMyArtifactMap();
  }

  public getPlanetUpdated$(): Monomitter<LocationId> {
    return this.entityStore.planetUpdated$;
  }

  public getArtifactUpdated$(): Monomitter<ArtifactId> {
    return this.entityStore.artifactUpdated$;
  }

  public getMyPlanetsUpdated$(): Monomitter<Map<LocationId, Planet>> {
    return this.entityStore.myPlanetsUpdated$;
  }

  public getMyArtifactsUpdated$(): Monomitter<Map<ArtifactId, Artifact>> {
    return this.entityStore.myArtifactsUpdated$;
  }

  public loadContract(contractAddress: string, contractABI: ContractInterface): Promise<Contract> {
    return this.ethConnection.loadContract(contractAddress, contractABI);
  }
}

export default GameManager;

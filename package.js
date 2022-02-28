"use strict";

const isValidMap = (mapName) => {
    return mapName !== 'base' && mapName !== 'hideout' && mapName !== 'privatearea' && mapName !== 'private area' && mapName !== 'develop';
}

const STASH_IDS = [
    "566abbc34bdc2d92178b4576", // Standard
    "5811ce572459770cba1a34ea", // Left Behind
    "5811ce662459770f6f490f32", // Prepare for escape
    "5811ce772459770e9e5f9532"  // Edge of darkness
];

class StashController {
    constructor(config) {
        this.config = config;

        // null means stash is unlocked
        this.stashSizes = null;
        this.items = DatabaseServer.tables.templates.items
    }

    _getInventory(sessionId) {
        return SaveServer.profiles[sessionId].characters.pmc.Inventory;
    }

    initProfile(sessionId) {
        const profile = SaveServer.profiles[sessionId];

        if (!profile.PathToTarkov) {
            profile.PathToTarkov = {};
        }

        if (!profile.PathToTarkov.mainStashId) {
            profile.PathToTarkov.mainStashId = this._getInventory(sessionId).stash;
        }
    }

    _getMainStashId(sessionId) {
        return SaveServer.profiles[sessionId].PathToTarkov.mainStashId;
    }

    _setSize(n) {
        let shouldCollectStashSizes = false;

        if (!this.stashSizes) {
            this.stashSizes = {};
            shouldCollectStashSizes = true;
        }

        STASH_IDS.forEach(stashId => {
            const gridProps = this.items[stashId]._props.Grids[0]._props;
            if (shouldCollectStashSizes) {
                this.stashSizes[stashId] = gridProps.cellsV;
            }

            gridProps.cellsV = n;
        });
    }

    _resetSize() {
        if (!this.stashSizes) {
            return;
        }

        STASH_IDS.forEach(stashId => {
            this.items[stashId]._props.Grids[0]._props.cellsV = this.stashSizes[stashId];
        });

        this.stashSizes = {};
    }

    _setMainStash(sessionId) {
        const inventory = this._getInventory(sessionId);
        inventory.stash = this._getMainStashId(sessionId);
    }

    _setSecondaryStash(stashId, sessionId) {
        const inventory = SaveServer.profiles[sessionId].characters.pmc.Inventory;
        inventory.stash = stashId;

        if (!inventory.items.find(item => item._id === stashId)) {
            inventory.items.push({ _id: stashId, _tpl: STASH_IDS[0] });
        }
    }

    updateStash(offraidPosition, sessionId) {
        if (!this.config.hideout_multistash_enabled) {
            return;
        }

        const mainStashAvailable = this.config.hideout_main_stash_access_via.includes(offraidPosition)
        const secondaryStash = this.config.hideout_secondary_stashes.find(stash => stash.access_via.includes(offraidPosition));

        if (mainStashAvailable) {
            this._resetSize();
            this._setMainStash(sessionId);
        }
        else if (secondaryStash) {
            this._setSize(secondaryStash.size);
            this._setSecondaryStash(secondaryStash.id, sessionId)
        }
        else {
            this._setSize(0);
        }
    }

}

const MAPLIST = [
    'laboratory',
    'factory4_day',
    'factory4_night',
    'bigmap', // customs
    'interchange',
    'lighthouse',
    'rezervbase',
    'shoreline',
    'woods',
]

const createSpawnPoint = (pos, rot, entrypoints) => {
    return {
        "Position": pos,
        "Rotation": rot || 0.0,
        "Sides": [
            "All"
        ],
        "Categories": [
            "Player"
        ],
        "Infiltration": entrypoints[0] || '',
        "DelayToCanSpawnSec": 3,
        "ColliderParams": {
            "_parent": "SpawnSphereParams",
            "_props": {
                "Center": {
                    "x": 0,
                    "y": 0,
                    "z": 0
                },
                "Radius": 0.0
            }
        },
        "BotZoneName": ""
    }
}

const createExitPoint = (entrypoints) => (name) => {
    return {
        "Name": name,
        "EntryPoints": entrypoints.join(','),
        "Chance": 100,
        "Count": 0,
        "Id": "",
        "MinTime": 0,
        "MaxTime": 0,
        "ExfiltrationType": "Individual",
        "PassageRequirement": "None",
        "PlayersCount": 0,
        "ExfiltrationTime": 10
    }
}

const getPosition = (spawnData) => {
    const pos = spawnData.Position;

    // work with Lua-CustomSpawnPointPointMaker format
    if (Array.isArray(pos)) {
        return { x: pos[0], y: pos[1], z: pos[2] }
    }

    return pos;
}

const getEntryPointsForMaps = (database) => {
    const result = {};

    MAPLIST.forEach(mapName => {
        result[mapName] = [];

        database.locations[mapName].base.exits.forEach(exitPayload => {
            const entrypoints = exitPayload.EntryPoints.split(',').map(x => x.trim()).filter(x => !!x);
            result[mapName] = [...result[mapName], ...entrypoints];
        })
    });

    return result;
}

const onGameStart = (cb) => {
    const vanillaGameStart = GameController.gameStart;

    GameController.gameStart = (url, info, sessionId) => {
        const result = vanillaGameStart(url, info, sessionId);
        cb(sessionId);
        return result;
    }
}

class OffraidPositionController {
    constructor(database, config, spawnConfig) {
        this.database = database;
        this.entrypoints = getEntryPointsForMaps(database);
        this.stashController = new StashController(config);
        this.config = config;
        this.spawnConfig = spawnConfig;
    }

    _addSpawnPoint(mapName, spawnPoint) {
        this.database.locations[mapName].base.SpawnPointParams.push(spawnPoint)
    }

    _removePlayerSpawns(mapName) {
        const base = this.database.locations[mapName].base;

        base.SpawnPointParams = base.SpawnPointParams
            .filter(params => params.Categories[0] !== 'Player')
    }

    _updateLockedMaps(offraidPosition) {
        const unlockedMaps = this.config.infiltrations[offraidPosition];

        MAPLIST.forEach(mapName => {
            if (mapName === 'laboratory') {
                const playerIsAtLab = this.config.laboratory_access_via.includes(offraidPosition)
                const unlocked = !this.config.laboratory_access_restriction || Boolean(playerIsAtLab);
                this.database.locations[mapName].base.Locked = !unlocked;
            } else if (mapName !== 'laboratory') {
                this.database.locations[mapName].base.Locked = !unlockedMaps[mapName];
            }
        })
    }

    _updateSpawnPoints(offraidPosition) {
        // Remove all player spawn points
        MAPLIST.forEach(mapName => {
            if (mapName !== 'laboratory') {
                this._removePlayerSpawns(mapName);
            }
        })

        // Add new spawn points according to player offraid position
        Object.keys(this.config.infiltrations[offraidPosition]).forEach(mapName => {
            const spawnpoints = this.config.infiltrations[offraidPosition][mapName];

            if (spawnpoints) {
                spawnpoints.forEach(spawnId => {
                    const spawnData = this.spawnConfig[mapName] && this.spawnConfig[mapName][spawnId];
                    if (spawnData) {
                        const spawnPoint = createSpawnPoint(getPosition(spawnData), spawnData.Rotation, this.entrypoints[mapName]);
                        this._addSpawnPoint(mapName, spawnPoint);
                    }
                });



            }
        })
    }

    initExfiltrations() {
        const locations = this.database.locations;

        // Extraction tweaks
        for (let i in locations) {
            if (isValidMap(i)) {
                for (let x in locations[i].base.exits) {
                    // Remove extracts restrictions
                    if (this.config.remove_all_exfils_restrictions && locations[i].base.exits[x].Name !== "EXFIL_Train" && !locations[i].base.exits[x].Name.includes("lab") || locations[i].base.exits[x].Name === "lab_Vent") {
                        if (locations[i].base.exits[x].PassageRequirement !== "None") {
                            locations[i].base.exits[x].PassageRequirement = "None";
                        }
                        if (locations[i].base.exits[x].ExfiltrationType !== "Individual") {
                            locations[i].base.exits[x].ExfiltrationType = "Individual";
                        }
                        if (locations[i].base.exits[x].Id !== '') {
                            locations[i].base.exits[x].Id = '';
                        }
                        if (locations[i].base.exits[x].Count !== 0) {
                            locations[i].base.exits[x].Count = 0;
                        }
                        if (locations[i].base.exits[x].RequirementTip !== '') {
                            locations[i].base.exits[x].RequirementTip = '';
                        }
                        if (locations[i].base.exits[x].RequiredSlot) {
                            delete locations[i].base.exits[x].RequiredSlot;
                        }
                    }

                    // Make all extractions available to extract
                    if (locations[i].base.exits[x].Name !== "EXFIL_Train") {
                        if (locations[i].base.exits[x].Chance !== 100) {
                            locations[i].base.exits[x].Chance = 100;
                        }
                    }
                }
            }
        }

        Object.keys(this.config.exfiltrations).forEach(mapName => {
            const extractPoints = Object.keys(this.config.exfiltrations[mapName]);
            this.database.locations[mapName].base.exits = extractPoints.map(createExitPoint(this.entrypoints[mapName]));
        });
    }

    getOffraidPosition = (sessionId) => {
        const profile = SaveServer.profiles[sessionId];

        if (!profile.PathToTarkov) {
            profile.PathToTarkov = {};
        }

        if (!profile.PathToTarkov.offraidPosition) {
            profile.PathToTarkov.offraidPosition = this.config.initial_offraid_position;
        }

        return profile.PathToTarkov.offraidPosition;
    }

    updateOffraidPosition(sessionId, offraidPosition) {
        if (!offraidPosition) {
            offraidPosition = this.getOffraidPosition(sessionId);
        }

        const profile = SaveServer.profiles[sessionId];

        const prevOffraidPosition = profile.PathToTarkov.offraidPosition;
        profile.PathToTarkov.offraidPosition = offraidPosition;

        if (prevOffraidPosition !== offraidPosition) {
            Logger.info(`=> PathToTarkov: player offraid position changed to '${offraidPosition}'`)
        }
        this._updateLockedMaps(offraidPosition);
        this._updateSpawnPoints(offraidPosition);

        this.stashController.updateStash(offraidPosition, sessionId);
    }
}

class PathToTarkov {
    constructor() {
        const mod = require("./package.json");
        const config = require("./config/config.json");
        const spawnConfig = require("./config/player_spawnpoints.json");
        const database = DatabaseServer.tables;


        if (!config.enabled) {
            Logger.warning('=> PathToTarkov is disabled!')
            return;
        }

        Logger.info(`Loading: ${mod.name} v${mod.version}`);

        const offraidPositionController = new OffraidPositionController(database, config, spawnConfig);

        offraidPositionController.initExfiltrations();

        ModLoader.onLoad[mod.name] = function () {

            onGameStart((sessionId) => {
                offraidPositionController.stashController.initProfile(sessionId);

                const offraidPosition = offraidPositionController.getOffraidPosition(sessionId)
                offraidPositionController.updateOffraidPosition(sessionId, offraidPosition);
                Logger.info(`=> PathToTarkov: player offraid position initialized to '${offraidPosition}'`)
            });

            let endRaidCb = () => { };

            const vanillaSaveProgress = InraidController.saveProgress;
            InraidController.saveProgress = (offraidData, sessionId) => {
                const isPlayerScav = offraidData.isPlayerScav;
                const currentLocationName = SaveServer.profiles[sessionId].inraid.location.toLowerCase();

                endRaidCb(currentLocationName, isPlayerScav);
                endRaidCb = () => { };

                return vanillaSaveProgress(offraidData, sessionId);
            }

            const vanillaEndOfflineRaid = MatchController.endOfflineRaid;

            // change the player offraid position according to the extract point used during the raid
            MatchController.endOfflineRaid = (info, sessionId) => {
                endRaidCb = (currentLocationName, isPlayerScav) => {
                    if (isPlayerScav && !config.player_scav_move_offraid_position) {
                        return;
                    }

                    const playerDied = !info.exitName;

                    if (config.reset_offraid_position_on_player_die && playerDied) {
                        offraidPositionController.updateOffraidPosition(sessionId, config.initial_offraid_position);
                        return;
                    }

                    const extractsConf = config.exfiltrations[currentLocationName];
                    const newOffraidPosition = extractsConf && extractsConf[info.exitName];

                    if (newOffraidPosition) {
                        offraidPositionController.updateOffraidPosition(sessionId, newOffraidPosition);
                    }
                }

                return vanillaEndOfflineRaid(info, sessionId);
            }

            Logger.success('=> PathToTarkov loaded!');

        };
    }
}

module.exports = new PathToTarkov();
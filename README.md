# IA locale pour Paseo

Un agent de code qui tourne **sur ta machine**, sans abonnement ni cloud : un plugin pour
[Paseo](https://paseo.sh) qui installe et règle tout seul le moteur (llama.cpp), l'agent
(Oh My Pi) et le modèle adapté à ta carte graphique.

> Version bêta. Ce dépôt contient le code source complet du plugin et des installateurs,
> pour que chacun puisse l'auditer.

## Télécharger

Le guide pas à pas est sur [capetlevrai.com](https://capetlevrai.com). Les installateurs sont aussi
dans **[Releases](https://github.com/Capetlevrai/ia-locale/releases)** : prends le fichier de ton système.

| Système | Fichier | Installation |
|---|---|---|
| Windows 10/11 | `CapetLocal-Setup.exe` | double-clic |
| Linux (x86_64) | `CapetLocal-Setup.sh` | dans un terminal : `bash ~/Downloads/CapetLocal-Setup.sh` |
| Mac à puce Apple (M1+) | `CapetLocal-Setup.sh` | dans le Terminal : `bash ~/Downloads/CapetLocal-Setup.sh` |

L'installateur met tout en place (Paseo, l'agent, le plugin, le moteur et le modèle conseillé),
puis ajoute l'agent « IA locale » à Paseo. Il peut être relancé sans risque. Aucun mot de passe
administrateur sous Linux et Mac. À la fin : ouvre Paseo, crée un agent et choisis « IA locale ».

Windows peut afficher « Windows a protégé votre ordinateur » : clique sur « Informations
complémentaires » puis « Exécuter quand même ».

## Ce qu'il faut

- Une carte **NVIDIA** de 10 Go ou plus (pilote récent), ou un **Mac à puce Apple**
  (24 Go de mémoire minimum, 36 Go pour les modèles « 24 Go »).
- Cartes AMD (Windows et Linux), Intel Arc (Windows seulement) et Mac : prise en charge **expérimentale**.
- 16 Go de RAM minimum, 32 Go conseillés ; 25 Go d'espace disque libre (le modèle pèse de 11 à 19 Go).

| Système | Carte | État |
|---|---|---|
| Windows | NVIDIA | testé |
| Linux | NVIDIA | testé (Ubuntu 24.04) |
| Windows | AMD, Intel Arc | expérimental |
| Linux | AMD | expérimental |
| macOS | Apple M1 et plus récents | expérimental, à tester |

Détails, modèles proposés et dépannage : [LISEZMOI.txt](LISEZMOI.txt).

## Mettre à jour, désinstaller

- **Mettre à jour** : télécharge le nouvel installateur et lance-le. Il remplace le plugin sans
  retélécharger les modèles. L'écran IA locale affiche la version installée et prévient quand
  une nouvelle version existe.
- **Désinstaller sous Windows** : ouvre `%LOCALAPPDATA%\CapetLocal` et double-clique sur
  `Desinstaller.cmd` (il demande si tu veux garder les modèles).
- **Désinstaller sous Mac et Linux** : `bash CapetLocal-Setup.sh --uninstall`
  (`--keep-models` garde les modèles).

Paseo, Bun et Node.js restent installés : ils servent à d'autres choses.

## Code source

Tout ce que l'installateur exécute est ici, en clair :

| Chemin | Rôle |
|---|---|
| `install.ps1` | Installation Windows en 7 étapes (Paseo, carte graphique, mémoire, Oh My Pi, Node.js, plugin, moteur et modèle) |
| `install.sh` | Même installation pour Linux et Mac (et désinstallation avec `--uninstall`) |
| `uninstall.ps1`, `Desinstaller.cmd` | Désinstallation sous Windows |
| `setup/Setup.cs` | Petit programme qui embarque `install.ps1` et le plugin dans `CapetLocal-Setup.exe` |
| `setup/unix-header.sh`, `setup/install-helper.mjs` | En-tête et assistant de `CapetLocal-Setup.sh` |
| `build-setup.ps1` | Construit `CapetLocal-Setup.exe` et `CapetLocal-Setup.sh` à partir de ces fichiers |
| `capet-local/` | Le plugin Paseo : détection de la carte, téléchargement du moteur et des modèles, réglages, passerelle locale |
| `capet-local/server/catalog.ts` | Liste des modèles, d'où ils sont téléchargés, leur empreinte SHA-256 et la VRAM qu'ils demandent |
| `capet-local/server/gateway.ts` | Passerelle locale entre l'agent et le moteur |

L'installateur ne télécharge que depuis les sources officielles : Paseo (paseo.sh), llama.cpp
(ggml-org sur GitHub), Bun (bun.sh) puis Oh My Pi (registre npm), Node.js (winget ou nodejs.org)
et les modèles sur Hugging Face (taille et empreinte SHA-256 vérifiées après téléchargement).
Le moteur et la passerelle du plugin n'écoutent qu'en local (`127.0.0.1`). La passerelle refuse
les requêtes venant d'un navigateur, et le moteur exige une clé que seule la passerelle connaît :
une page web ouverte sur ton PC ne peut ni utiliser ni piloter l'IA locale. Le plugin interroge
GitHub deux fois par jour au plus pour savoir si une nouvelle version existe ; rien d'autre ne sort.

Pour reconstruire les installateurs sous Windows : `powershell -ExecutionPolicy Bypass -File .\build-setup.ps1`.

## Un souci ?

Ouvre une [issue](https://github.com/Capetlevrai/ia-locale/issues) avec ton système, ta carte
graphique et le fichier `CapetLocal/logs/llama-server.log` (dans `%LOCALAPPDATA%` sous
Windows, `~/.local/share` sous Linux, `~/Library/Application Support` sur Mac).

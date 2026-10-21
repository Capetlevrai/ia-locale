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
  (24 Go de mémoire ou plus conseillés).
- Cartes AMD et Intel, et Mac : prise en charge **expérimentale**.
- 16 Go de RAM minimum, 32 Go conseillés ; 15 à 20 Go d'espace disque pour le modèle.

| Système | Carte | État |
|---|---|---|
| Windows | NVIDIA | testé |
| Linux | NVIDIA | testé (Ubuntu 24.04) |
| Windows, Linux | AMD, Intel | expérimental |
| macOS | Apple M1 et plus récents | expérimental, à tester |

Détails, modèles proposés et dépannage : [LISEZMOI.txt](LISEZMOI.txt).

## Code source

Tout ce que l'installateur exécute est ici, en clair :

| Chemin | Rôle |
|---|---|
| `install.ps1` | Installation Windows en 7 étapes (Paseo, carte graphique, mémoire, Oh My Pi, Node.js, plugin, moteur et modèle) |
| `install.sh` | Même installation pour Linux et Mac |
| `setup/Setup.cs` | Petit programme qui embarque `install.ps1` et le plugin dans `CapetLocal-Setup.exe` |
| `setup/unix-header.sh`, `setup/install-helper.mjs` | En-tête et assistant de `CapetLocal-Setup.sh` |
| `build-setup.ps1` | Construit `CapetLocal-Setup.exe` et `CapetLocal-Setup.sh` à partir de ces fichiers |
| `capet-local/` | Le plugin Paseo : détection de la carte, téléchargement du moteur et des modèles, réglages, passerelle locale |
| `capet-local/server/catalog.ts` | Liste des modèles, d'où ils sont téléchargés et la VRAM qu'ils demandent |

L'installateur ne télécharge que depuis les sources officielles : Paseo (paseo.sh), llama.cpp
(ggml-org sur GitHub), Bun (bun.sh) puis Oh My Pi (registre npm), Node.js (winget ou nodejs.org)
et les modèles sur Hugging Face. Le moteur et la passerelle du plugin n'écoutent qu'en local
(`127.0.0.1`).

Pour reconstruire les installateurs sous Windows : `powershell -ExecutionPolicy Bypass -File .uild-setup.ps1`.

## Un souci ?

Ouvre une [issue](https://github.com/Capetlevrai/ia-locale/issues) avec ton système, ta carte
graphique et le fichier `CapetLocal/logs/llama-server.log` (dans `%LOCALAPPDATA%` sous
Windows, `~/.local/share` sous Linux, `~/Library/Application Support` sur Mac).

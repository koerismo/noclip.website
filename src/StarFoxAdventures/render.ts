import * as Viewer from '../viewer';
import { GXRenderHelperGfx } from '../gx/gx_render';
import { GfxDevice, GfxFormat, GfxSampler, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode } from '../gfx/platform/GfxPlatform';
import { GfxRenderInstList, GfxRenderInstManager } from "../gfx/render/GfxRenderer";
import { CameraController } from '../Camera';
import { standardFullClearRenderPassDescriptor, ColorTexture } from '../gfx/helpers/RenderTargetHelpers';
import { GfxrAttachmentSlot, GfxrGraphBuilder, GfxrRenderTargetDescription, GfxrTemporalTexture } from '../gfx/render/GfxRenderGraph';
import { colorNewFromRGBA8 } from '../Color';

import { SFAAnimationController } from './animation';
import { nArray } from '../util';
import { TextureMapping } from '../TextureHolder';

export interface SceneRenderContext {
    getPreviousFrameTexture: () => ColorTexture;
    getPreviousFrameTextureSampler: () => GfxSampler;
    viewerInput: Viewer.ViewerRenderInput;
    animController: SFAAnimationController;
}

const BACKGROUND_COLOR = colorNewFromRGBA8(0xCCCCCCFF);

export interface SFARenderLists {
    atmosphere: GfxRenderInstList;
    skyscape: GfxRenderInstList;
    world: GfxRenderInstList[/* 3 */];
    waters: GfxRenderInstList;
    furs: GfxRenderInstList;
}

export class SFARenderer implements Viewer.SceneGfx {
    protected renderHelper: GXRenderHelperGfx;
    protected renderLists: SFARenderLists;
    
    private sceneTextureSampler: GfxSampler;
    private opaqueSceneTextureMapping = new TextureMapping();
    protected previousFrameTexture = new ColorTexture();
    // private mainColorTemporalTexture = new GfxrTemporalTexture();

    private mainColorDesc = new GfxrRenderTargetDescription(GfxFormat.U8_RGBA_RT);
    protected mainDepthDesc = new GfxrRenderTargetDescription(GfxFormat.D32F);

    constructor(device: GfxDevice, protected animController: SFAAnimationController) {
        this.renderHelper = new GXRenderHelperGfx(device);
        this.renderHelper.renderInstManager.disableSimpleMode();

        this.renderLists = {
            atmosphere: new GfxRenderInstList(),
            skyscape: new GfxRenderInstList(),
            world: nArray(3, () => new GfxRenderInstList()),
            waters: new GfxRenderInstList(),
            furs: new GfxRenderInstList(),
        };

        const cache = this.renderHelper.getCache();
        this.sceneTextureSampler = cache.createSampler(device, {
            wrapS: GfxWrapMode.CLAMP,
            wrapT: GfxWrapMode.CLAMP,
            minFilter: GfxTexFilterMode.BILINEAR,
            magFilter: GfxTexFilterMode.BILINEAR,
            mipFilter: GfxMipFilterMode.NO_MIP,
            minLOD: 0,
            maxLOD: 100,
        });

        this.opaqueSceneTextureMapping.gfxSampler = this.sceneTextureSampler;
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(1 / 3); // Slow down the default camera a bit
    }

    protected update(viewerInput: Viewer.ViewerRenderInput) {
        this.animController.update(viewerInput);
    }

    protected addSkyRenderInsts(device: GfxDevice, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, sceneCtx: SceneRenderContext) {}
    protected addSkyRenderPasses(device: GfxDevice, builder: GfxrGraphBuilder, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, mainColorTargetID: number, mainDepthTargetID: number, sceneCtx: SceneRenderContext) {}

    protected addWorldRenderInsts(device: GfxDevice, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, sceneCtx: SceneRenderContext) {}

    private addWorldRenderPasses(device: GfxDevice, builder: GfxrGraphBuilder, renderInstManager: GfxRenderInstManager, renderLists: SFARenderLists, mainColorTargetID: number, mainDepthTargetID: number, sceneCtx: SceneRenderContext) {
        builder.pushPass((pass) => {
            pass.setDebugName('World Opaque');
            pass.setViewport(sceneCtx.viewerInput.viewport);
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderLists.world[0].drawOnPassRenderer(device, renderInstManager.gfxRenderCache, passRenderer);
                renderLists.furs.drawOnPassRenderer(device, renderInstManager.gfxRenderCache, passRenderer);
            });
        });

        // TODO: Downscale to 1/8th scale and apply filtering (?)
        const mainColorResolveTextureID = builder.resolveRenderTarget(mainColorTargetID);

        builder.pushPass((pass) => {
            pass.setDebugName('World Transparents');
            pass.setViewport(sceneCtx.viewerInput.viewport);
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.attachResolveTexture(mainColorResolveTextureID);

            pass.exec((passRenderer, scope) => {
                this.opaqueSceneTextureMapping.gfxTexture = scope.getResolveTextureForID(mainColorResolveTextureID);
                renderLists.waters.resolveLateSamplerBinding('opaque-scene-texture', this.opaqueSceneTextureMapping);

                renderLists.waters.drawOnPassRenderer(device, renderInstManager.gfxRenderCache, passRenderer);
                renderLists.world[1].drawOnPassRenderer(device, renderInstManager.gfxRenderCache, passRenderer);
                renderLists.world[2].drawOnPassRenderer(device, renderInstManager.gfxRenderCache, passRenderer);
            });
        });
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        this.update(viewerInput);

        this.renderHelper.pushTemplateRenderInst();
        const renderInstManager = this.renderHelper.renderInstManager;

        // TODO: use GfxrTemporalTexture instead
        this.previousFrameTexture.setParameters(device, viewerInput.backbufferWidth, viewerInput.backbufferHeight);

        const sceneCtx: SceneRenderContext = {
            getPreviousFrameTexture: () => this.previousFrameTexture,
            getPreviousFrameTextureSampler: () => this.sceneTextureSampler,
            viewerInput,
            animController: this.animController,
        };

        this.addSkyRenderInsts(device, renderInstManager, this.renderLists, sceneCtx);
        this.addWorldRenderInsts(device, renderInstManager, this.renderLists, sceneCtx);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        this.mainColorDesc.setDimensions(viewerInput.backbufferWidth, viewerInput.backbufferHeight, viewerInput.sampleCount);
        this.mainColorDesc.colorClearColor = BACKGROUND_COLOR;

        this.mainDepthDesc.copyDimensions(this.mainColorDesc);
        this.mainDepthDesc.depthClearValue = standardFullClearRenderPassDescriptor.depthClearValue;

        // this.mainColorTemporalTexture.setDescription(device, this.mainColorDesc);

        const mainColorTargetID = builder.createRenderTargetID(this.mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(this.mainDepthDesc, 'Main Depth');

        this.addSkyRenderPasses(device, builder, renderInstManager, this.renderLists, mainColorTargetID, mainDepthTargetID, sceneCtx);
        this.addWorldRenderPasses(device, builder, renderInstManager, this.renderLists, mainColorTargetID, mainDepthTargetID, sceneCtx);

        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        // TODO(jstpierre): Make it so that we don't need an extra pass for this blit in the future?
        // Maybe have copyTextureToTexture as a native device method?
        builder.pushPass((pass) => {
            pass.setDebugName('Copy to Temporal Texture');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
        });
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, this.previousFrameTexture.gfxTexture!);
        // builder.resolveRenderTargetToExternalTexture(mainColorTargetID, this.mainColorTemporalTexture.getTextureForResolving());

        renderInstManager.popTemplateRenderInst();

        this.renderHelper.prepareToRender(device);

        this.renderHelper.renderGraph.execute(device, builder);
        renderInstManager.resetRenderInsts();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
    }
}
